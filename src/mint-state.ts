/**
 * Answers one question: has this token been minted yet?
 *
 * There are two ways to find out, and this server uses both.
 *
 *   polling   one mint-count read every few seconds. Always works, needs no
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
 *    if a later read disagrees, because RPC nodes behind a load balancer
 *    sometimes answer from an older block.
 */

import type { ResolvedConfig } from "./config.ts";
import { redact, redactError } from "./redact.ts";
import type { RevealStore } from "./reveal-store.ts";
import {
  type RpcClient,
  RpcTransportError,
  readTokenExists,
  readTotalMinted,
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
  | "rpc-unavailable"
  /** Too many chain reads already in flight, so we assumed the worst. */
  | "throttled";

/**
 * Which contract call answers "how many tokens have been minted".
 *
 *   unknown       not probed yet
 *   mint-stats    getMintStats(address), whose second value is `_totalMinted()`
 *   total-supply  totalSupply(), which a burn lowers
 */
export type SupplyReader = "unknown" | "mint-stats" | "total-supply";

export type RevealDecision = {
  revealed: boolean;
  reason: RevealReason;
};

export type MintStateStatus = {
  mode: string;
  store: string;
  highestMintedTokenId: number | null;
  /** Tokens minted so far. Burn-immune where the contract allows it. */
  mintedCount: number | null;
  /** Which contract read produced `mintedCount`. See `readMintedCount`. */
  supplyReader: SupplyReader;
  lastPollAt: string | null;
  lastWebhookAt: string | null;
  webhookMints: number;
  /** Reads declined because too many were already in flight. "ownerOf" mode only. */
  throttledChecks: number;
  lastError: string | null;
};

/** Raised instead of making a chain read we decided not to make. */
export class ThrottledError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ThrottledError";
  }
}

const BLOCK_NUMBER_TTL_MS = 6_000;
const NEGATIVE_CACHE_LIMIT = 20_000;

/**
 * Ceiling on concurrent `ownerOf` reads.
 *
 * "ownerOf" mode spends one chain read per distinct token ID, so anything that
 * walks the range once (a scraper, a marketplace reindexing your collection)
 * turns one HTTP request into one RPC call, with nothing in between. That is
 * your RPC bill, and your provider's rate limit, driven by whoever happens to
 * be pointing at the server.
 *
 * Past the ceiling we answer without asking the chain, which withholds the
 * token. Costing a reveal a few seconds is the right side to err on, and
 * "sequential" mode never reaches this because one read answers every token.
 */
const MAX_INFLIGHT_TOKEN_CHECKS = 64;

/**
 * How long to wait before retrying an RPC endpoint that just failed. Without
 * this, every request retries a dead endpoint back to back for as long as the
 * outage lasts, which turns a slow endpoint into a hammered one.
 */
const RPC_FAILURE_COOLDOWN_MS = 2_000;

export class MintStateReader {
  private readonly config: ResolvedConfig;
  private readonly client: RpcClient;
  private readonly store: RevealStore;

  // Sequential mode state.
  private highWaterTokenId: number | null = null;
  private lastMintedCount: number | null = null;
  private supplyReader: SupplyReader = "unknown";
  private lastPollAtMs: number | null = null;
  private supplyRefresh: Promise<void> | null = null;

  // ownerOf mode state.
  private readonly mintedTokens = new Set<number>();
  private readonly unmintedUntilMs = new Map<number, number>();
  private readonly inflightTokenChecks = new Map<number, Promise<boolean>>();

  private cachedBlockNumber: { value: number; atMs: number } | null = null;
  private lastWebhookAtMs: number | null = null;
  private webhookMints = 0;
  private throttledChecks = 0;
  private lastError: string | null = null;
  private lastFailureAtMs: number | null = null;
  /**
   * Whether the most recent read failed. A flag rather than a comparison of two
   * timestamps, because a success and a failure inside the same millisecond
   * would make that comparison answer "healthy".
   */
  private lastReadFailed = false;

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
      if (minted) return { revealed: true, reason: "minted" };
      // A "no" that rests on a failed read is not the same answer as a "no" from
      // a healthy chain, even though both withhold the token. Say which it is,
      // because /status and the troubleshooting docs lean on this header.
      return { revealed: false, reason: this.lastReadFailed ? "rpc-unavailable" : "unminted" };
    } catch (error) {
      // A throttle is a decision this server made, not a fault to report at
      // /status. It has its own counter there instead.
      if (error instanceof ThrottledError) return { revealed: false, reason: "throttled" };
      this.lastError = redactError(error);
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
      // The local bump above is what reveals the token. Sharing it with the
      // other instances is an optimisation, so a store that is down must not
      // turn a good delivery into a 500 the provider will retry.
      await this.shareHighWater(highest);
      this.lastWebhookAtMs = Date.now();
      this.webhookMints += applied;
    }

    return applied;
  }

  /** Surface a failure raised outside this class, so /status reports it too. */
  recordError(message: string): void {
    this.lastError = redact(message);
  }

  status(): MintStateStatus {
    return {
      mode: this.config.mintState.mode,
      store: this.store.kind,
      highestMintedTokenId: this.highWaterTokenId,
      mintedCount: this.lastMintedCount,
      supplyReader: this.supplyReader,
      lastPollAt: this.lastPollAtMs ? new Date(this.lastPollAtMs).toISOString() : null,
      lastWebhookAt: this.lastWebhookAtMs ? new Date(this.lastWebhookAtMs).toISOString() : null,
      webhookMints: this.webhookMints,
      throttledChecks: this.throttledChecks,
      lastError: this.lastError,
    };
  }

  // --- sequential ---------------------------------------------------------

  /**
   * SeaDrop hands out token IDs in order, so one number answers every token.
   * A single mint-count read per TTL window serves the whole collection,
   * however much traffic arrives.
   */
  private async isMintedSequential(tokenId: number): Promise<boolean> {
    // Settled tokens need no work at all, whatever the cache says.
    if (this.highWaterTokenId !== null && tokenId <= this.highWaterTokenId) return true;

    // A webhook may have landed on another instance since our last poll.
    const shared = await this.readSharedHighWater();
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

  private async readSharedHighWater(): Promise<number | null> {
    try {
      return await this.store.getHighWater();
    } catch (error) {
      this.lastError = `reveal store read failed: ${redactError(error)}`;
      return null;
    }
  }

  private async refreshSupply(): Promise<void> {
    // Single flight: a burst of requests triggers one RPC call, not hundreds.
    if (this.supplyRefresh) return this.supplyRefresh;

    // Back off from an endpoint that just failed, rather than retrying it once
    // per request for the length of the outage.
    //
    // This applies before the first successful read as well as after one. A
    // drop with nothing minted yet has no high water mark to fall back on, and
    // that is exactly when the server is busiest, so skipping the backoff there
    // would hammer a struggling endpoint at the worst possible moment. The
    // caller still gets "not minted", and `lastReadFailed` still makes it read
    // as "rpc-unavailable" rather than a healthy "unminted".
    if (
      this.lastFailureAtMs !== null &&
      Date.now() - this.lastFailureAtMs < RPC_FAILURE_COOLDOWN_MS
    ) {
      return;
    }

    const run = (async () => {
      try {
        const blockTag = await this.blockTag();
        const total = await this.readMintedCount(blockTag);
        const highest = Math.min(this.config.tokenIdStart + total - 1, this.config.tokenIdEnd);
        this.lastMintedCount = total;
        this.lastPollAtMs = Date.now();
        this.lastError = null;
        this.lastFailureAtMs = null;
        this.lastReadFailed = false;
        if (this.highWaterTokenId === null || highest > this.highWaterTokenId) {
          this.highWaterTokenId = highest;
          if (highest >= this.config.tokenIdStart) await this.shareHighWater(highest);
        }
      } catch (error) {
        this.lastError = redactError(error);
        this.lastFailureAtMs = Date.now();
        this.lastReadFailed = true;
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

  /**
   * How many tokens have been minted, preferring the count a burn cannot lower.
   *
   * `totalSupply()` on ERC721A is minted minus burned, and sequential mode
   * turns the count into "every token ID up to here exists". Those two
   * disagree the moment anyone burns: with one token burned, the highest
   * minted ID sits on the placeholder until the next mint replaces it, and
   * forever if the drop never mints out. Nothing recovers it, because the
   * chain is answering honestly and the answer is the wrong question.
   *
   * `getMintStats` asks the right one. It is probed once, on the first read,
   * and a contract that does not have it is remembered so the extra call is
   * not repeated for the life of the process.
   *
   * The result is only trusted while it fits inside the drop. A count past
   * `maxSupply` is not a mint count: either the configured contract is not the
   * one this server was built for, or some unrelated function answers to the
   * same four bytes. Either way `highest` is clamped to `tokenIdEnd` a few
   * lines later, so believing it would reveal the entire collection at once.
   */
  private async readMintedCount(blockTag: string): Promise<number> {
    if (this.supplyReader !== "total-supply") {
      const minted = await readTotalMinted(this.client, this.config.contract, blockTag);
      if (minted !== null && minted >= 0n && minted <= BigInt(this.config.maxSupply)) {
        this.supplyReader = "mint-stats";
        return Number(minted);
      }
      this.supplyReader = "total-supply";
    }

    return Number(await readTotalSupply(this.client, this.config.contract, blockTag));
  }

  /**
   * Publish the high water mark to the shared store. Failures are recorded and
   * swallowed: the local mark is already correct, the poller will try again,
   * and no reveal depends on this succeeding.
   */
  private async shareHighWater(tokenId: number): Promise<void> {
    try {
      await this.store.bumpHighWater(tokenId);
    } catch (error) {
      this.lastError = `reveal store write failed: ${redactError(error)}`;
    }
  }

  // --- ownerOf -----------------------------------------------------------

  private async isMintedByOwnerOf(tokenId: number): Promise<boolean> {
    if (this.mintedTokens.has(tokenId)) return true;

    const unmintedUntil = this.unmintedUntilMs.get(tokenId);
    if (unmintedUntil !== undefined && Date.now() < unmintedUntil) return false;

    const inflight = this.inflightTokenChecks.get(tokenId);
    if (inflight) return inflight;

    if (this.inflightTokenChecks.size >= MAX_INFLIGHT_TOKEN_CHECKS) {
      this.throttledChecks += 1;
      throw new ThrottledError(
        `${MAX_INFLIGHT_TOKEN_CHECKS} chain reads already in flight, so this one was not made`,
      );
    }

    const check = (async () => {
      try {
        const blockTag = await this.blockTag();
        const exists = await readTokenExists(this.client, this.config.contract, tokenId, blockTag);
        if (exists) {
          this.mintedTokens.add(tokenId);
          this.unmintedUntilMs.delete(tokenId);
        } else {
          // Evict the oldest entries rather than emptying the map. Clearing it
          // sends every token that was being withheld back to the chain at
          // once, which is a stampede on a timer.
          while (this.unmintedUntilMs.size >= NEGATIVE_CACHE_LIMIT) {
            const oldest = this.unmintedUntilMs.keys().next();
            if (oldest.done) break;
            this.unmintedUntilMs.delete(oldest.value);
          }
          this.unmintedUntilMs.set(tokenId, Date.now() + this.config.mintState.ttlSeconds * 1000);
        }
        this.lastPollAtMs = Date.now();
        this.lastError = null;
        this.lastFailureAtMs = null;
        this.lastReadFailed = false;
        return exists;
      } catch (error) {
        this.lastFailureAtMs = Date.now();
        this.lastReadFailed = true;
        throw error;
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
    return `0x${target.toString(16)}`;
  }
}
