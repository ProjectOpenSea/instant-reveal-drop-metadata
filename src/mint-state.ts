/**
 * Answers one question: has this token been minted yet?
 *
 * There are two ways to find out, and this server uses both.
 *
 *   polling   a `totalSupply()` read every few seconds. Always works, needs no
 *             setup, and is the floor on how late a reveal can be.
 *   webhook   a push from your node provider the moment the mint lands. Faster,
 *             optional, and never trusted to say a token is *not* minted.
 *
 * Two rules shape everything here:
 *
 * 1. Fail closed. If the chain is unreachable we serve the placeholder. Serving
 *    real metadata for an unminted token is the one mistake that cannot be
 *    undone, so an outage costs you a late reveal, never an early one.
 *
 * 2. Never un-mint a token. Once a token is known minted we remember it, even
 *    if a later read disagrees (a burn lowers `totalSupply`, and RPC nodes
 *    behind a load balancer sometimes answer from an older block).
 */

import type { ResolvedConfig } from "./config.ts";
import type { RevealStore } from "./reveal-store.ts";
import {
  RpcClient,
  RpcTransportError,
  readTokenExists,
  readTotalSupply,
} from "./rpc.ts";

export type RevealReason =
  /** The token is minted, here is the real metadata. */
  | "minted"
  /** The token is not minted yet. */
  | "unminted"
  /** reveal.mode is "always", everything is public. */
  | "reveal-all"
  /** reveal.mode is "never". */
  | "reveal-none"
  /** We could not reach the chain, so we assumed the worst. */
  | "rpc-unavailable";

export type RevealDecision = {
  revealed: boolean;
  reason: RevealReason;
};

export type MintStateStatus = {
  mode: string;
  store: string;
  highestMintedTokenId: number | null;
  totalSupply: number | null;
  lastPollAt: string | null;
  lastWebhookAt: string | null;
  webhookMints: number;
  lastError: string | null;
};

const BLOCK_NUMBER_TTL_MS = 6_000;
const NEGATIVE_CACHE_LIMIT = 20_000;

export class MintStateReader {
  private readonly config: ResolvedConfig;
  private readonly client: RpcClient;
  private readonly store: RevealStore;

  // Sequential mode state.
  private highWaterTokenId: number | null = null;
  private lastTotalSupply: number | null = null;
  private lastPollAtMs: number | null = null;
  private supplyRefresh: Promise<void> | null = null;

  // ownerOf mode state.
  private readonly mintedTokens = new Set<number>();
  private readonly unmintedUntilMs = new Map<number, number>();
  private readonly inflightTokenChecks = new Map<number, Promise<boolean>>();

  private cachedBlockNumber: { value: number; atMs: number } | null = null;
  private lastWebhookAtMs: number | null = null;
  private webhookMints = 0;
  private lastError: string | null = null;

  constructor(config: ResolvedConfig, client: RpcClient, store: RevealStore) {
    this.config = config;
    this.client = client;
    this.store = store;
  }

  async decide(tokenId: number, revealAllOverride = false): Promise<RevealDecision> {
    if (revealAllOverride || this.config.reveal.mode === "always") {
      return { revealed: true, reason: "reveal-all" };
    }
    if (this.config.reveal.mode === "never") {
      return { revealed: false, reason: "reveal-none" };
    }

    try {
      const minted =
        this.config.mintState.mode === "sequential"
          ? await this.isMintedSequential(tokenId)
          : await this.isMintedByOwnerOf(tokenId);
      return minted
        ? { revealed: true, reason: "minted" }
        : { revealed: false, reason: "unminted" };
    } catch (error) {
      this.lastError = error instanceof Error ? error.message : String(error);
      return { revealed: false, reason: "rpc-unavailable" };
    }
  }

  /**
   * Called by the webhook routes. Raises the high water mark without waiting
   * for the next poll, which is the entire point of running a webhook.
   *
   * Only ever raises. A webhook cannot hide a token, and a replayed or
   * out-of-order delivery is harmless.
   */
  async recordMintedTokens(tokenIds: readonly number[]): Promise<number> {
    let applied = 0;
    let highest: number | null = null;

    for (const tokenId of tokenIds) {
      if (
        !Number.isInteger(tokenId) ||
        tokenId < this.config.tokenIdStart ||
        tokenId > this.config.tokenIdEnd
      ) {
        continue;
      }
      applied += 1;
      this.mintedTokens.add(tokenId);
      this.unmintedUntilMs.delete(tokenId);
      if (highest === null || tokenId > highest) highest = tokenId;
    }

    if (highest !== null) {
      if (this.highWaterTokenId === null || highest > this.highWaterTokenId) {
        this.highWaterTokenId = highest;
      }
      await this.store.bumpHighWater(highest);
      this.lastWebhookAtMs = Date.now();
      this.webhookMints += applied;
    }

    return applied;
  }

  status(): MintStateStatus {
    return {
      mode: this.config.mintState.mode,
      store: this.store.kind,
      highestMintedTokenId: this.highWaterTokenId,
      totalSupply: this.lastTotalSupply,
      lastPollAt: this.lastPollAtMs ? new Date(this.lastPollAtMs).toISOString() : null,
      lastWebhookAt: this.lastWebhookAtMs ? new Date(this.lastWebhookAtMs).toISOString() : null,
      webhookMints: this.webhookMints,
      lastError: this.lastError,
    };
  }

  // --- sequential ---------------------------------------------------------

  /**
   * SeaDrop hands out token IDs in order, so one number answers every token.
   * A single `totalSupply()` read per TTL window serves the whole collection,
   * however much traffic arrives.
   */
  private async isMintedSequential(tokenId: number): Promise<boolean> {
    // Settled tokens need no work at all, whatever the cache says.
    if (this.highWaterTokenId !== null && tokenId <= this.highWaterTokenId) return true;

    // A webhook may have landed on another instance since our last poll.
    const shared = await this.store.getHighWater();
    if (shared !== null && (this.highWaterTokenId === null || shared > this.highWaterTokenId)) {
      this.highWaterTokenId = shared;
      if (tokenId <= shared) return true;
    }

    const fresh =
      this.lastPollAtMs !== null &&
      Date.now() - this.lastPollAtMs < this.config.mintState.ttlSeconds * 1000;
    if (!fresh) await this.refreshSupply();

    return this.highWaterTokenId !== null && tokenId <= this.highWaterTokenId;
  }

  private async refreshSupply(): Promise<void> {
    // Single flight: a burst of requests triggers one RPC call, not hundreds.
    if (this.supplyRefresh) return this.supplyRefresh;

    const run = (async () => {
      try {
        const blockTag = await this.blockTag();
        const total = Number(await readTotalSupply(this.client, this.config.contract, blockTag));
        const highest = Math.min(this.config.tokenIdStart + total - 1, this.config.tokenIdEnd);
        this.lastTotalSupply = total;
        this.lastPollAtMs = Date.now();
        this.lastError = null;
        if (this.highWaterTokenId === null || highest > this.highWaterTokenId) {
          this.highWaterTokenId = highest;
          if (highest >= this.config.tokenIdStart) await this.store.bumpHighWater(highest);
        }
      } catch (error) {
        this.lastError = error instanceof Error ? error.message : String(error);
        // Keep whatever we already knew. If we knew nothing, the caller sees
        // "not minted" and serves the placeholder, which is the safe answer.
        if (this.highWaterTokenId === null) {
          throw error instanceof Error ? error : new RpcTransportError(String(error));
        }
      } finally {
        this.supplyRefresh = null;
      }
    })();

    this.supplyRefresh = run;
    return run;
  }

  // --- ownerOf -----------------------------------------------------------

  private async isMintedByOwnerOf(tokenId: number): Promise<boolean> {
    if (this.mintedTokens.has(tokenId)) return true;

    const unmintedUntil = this.unmintedUntilMs.get(tokenId);
    if (unmintedUntil !== undefined && Date.now() < unmintedUntil) return false;

    const inflight = this.inflightTokenChecks.get(tokenId);
    if (inflight) return inflight;

    const check = (async () => {
      try {
        const blockTag = await this.blockTag();
        const exists = await readTokenExists(this.client, this.config.contract, tokenId, blockTag);
        if (exists) {
          this.mintedTokens.add(tokenId);
          this.unmintedUntilMs.delete(tokenId);
        } else {
          if (this.unmintedUntilMs.size > NEGATIVE_CACHE_LIMIT) this.unmintedUntilMs.clear();
          this.unmintedUntilMs.set(tokenId, Date.now() + this.config.mintState.ttlSeconds * 1000);
        }
        this.lastPollAtMs = Date.now();
        this.lastError = null;
        return exists;
      } finally {
        this.inflightTokenChecks.delete(tokenId);
      }
    })();

    this.inflightTokenChecks.set(tokenId, check);
    return check;
  }

  // --- shared ------------------------------------------------------------

  /**
   * "latest" unless you asked for confirmations, in which case we read a block
   * that is already buried. Costs one extra, cached, call.
   */
  private async blockTag(): Promise<string> {
    const confirmations = this.config.mintState.confirmations;
    if (confirmations <= 0) return "latest";

    const now = Date.now();
    if (!this.cachedBlockNumber || now - this.cachedBlockNumber.atMs > BLOCK_NUMBER_TTL_MS) {
      this.cachedBlockNumber = { value: await this.client.blockNumber(), atMs: now };
    }
    const target = Math.max(0, this.cachedBlockNumber.value - confirmations);
    return "0x" + target.toString(16);
  }
}
