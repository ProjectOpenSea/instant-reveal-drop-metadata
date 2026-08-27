/**
 * A fake chain and a fake metadata host, so the tests never touch the network.
 */

import type { DropConfig } from "../src/config.ts";
import type { Env } from "../src/env.ts";
import type { KvLike, RevealStore } from "../src/reveal-store.ts";
import { createRuntime, type Runtime } from "../src/runtime.ts";
import type { FetchLike } from "../src/rpc.ts";

export const CONTRACT = "0x1111111111111111111111111111111111111111";
export const RPC_URL = "https://rpc.test/v2/key";
export const METADATA_URL = "https://metadata.test/drop";

export type FakeChain = {
  /** Tokens tokenIdStart..(tokenIdStart + totalSupply - 1) are minted. */
  totalSupply: number;
  /** Make every eth_call fail, to check the fail-closed behaviour. */
  down: boolean;
  /** How many JSON-RPC requests have been made. */
  rpcCalls: number;
  /** How many metadata fetches have been made. */
  metadataCalls: number;
  /** Make the metadata source return a server error, to check the fallback. */
  metadataDown: boolean;
};

export function baseConfig(overrides: Partial<DropConfig> = {}): DropConfig {
  return {
    chain: "base",
    contract: CONTRACT,
    tokenIdStart: 1,
    maxSupply: 10,
    reveal: { mode: "on-mint", shuffle: { enabled: false } },
    mintState: { mode: "sequential", ttlSeconds: 10 },
    metadata: { source: "http" },
    placeholder: {
      name: "Unrevealed #{tokenId}",
      description: "not yet",
      image: "ipfs://placeholder",
    },
    ...overrides,
  };
}

export function makeFakeFetch(chain: FakeChain): FetchLike {
  return async (input: string, init?: RequestInit): Promise<Response> => {
    if (input.startsWith(RPC_URL)) {
      chain.rpcCalls += 1;
      if (chain.down) {
        return jsonResponse(
          { jsonrpc: "2.0", id: 1, error: { code: -32000, message: "node is having a moment" } },
          200,
        );
      }

      const body = JSON.parse(String(init?.body ?? "{}")) as {
        id: number;
        method: string;
        params: unknown[];
      };

      if (body.method === "eth_blockNumber") {
        return jsonResponse({ jsonrpc: "2.0", id: body.id, result: "0x1000" }, 200);
      }

      if (body.method === "eth_call") {
        const call = body.params[0] as { data: string };
        const selector = call.data.slice(0, 10);

        if (selector === "0x18160ddd") {
          return jsonResponse(
            { jsonrpc: "2.0", id: body.id, result: hexWord(chain.totalSupply) },
            200,
          );
        }
        if (selector === "0x6352211e") {
          const tokenId = Number(BigInt("0x" + call.data.slice(10)));
          const minted = tokenId >= 1 && tokenId <= chain.totalSupply;
          return minted
            ? jsonResponse(
                { jsonrpc: "2.0", id: body.id, result: "0x" + "22".padStart(64, "0") },
                200,
              )
            : jsonResponse(
                {
                  jsonrpc: "2.0",
                  id: body.id,
                  error: { code: 3, message: "execution reverted", data: "0xdf2d9b42" },
                },
                200,
              );
        }
      }

      return jsonResponse({ jsonrpc: "2.0", id: 1, error: { code: -32601, message: "no" } }, 200);
    }

    if (input.startsWith(METADATA_URL)) {
      chain.metadataCalls += 1;
      if (chain.metadataDown) return new Response("upstream is unhappy", { status: 502 });
      const index = Number(input.slice(input.lastIndexOf("/") + 1).replace(".json", ""));
      if (!Number.isInteger(index) || index < 0 || index > 999) {
        return new Response("not found", { status: 404 });
      }
      return jsonResponse(
        {
          name: `Artwork ${index}`,
          image: `ipfs://art/${index}.png`,
          attributes: [{ trait_type: "Index", value: index }],
        },
        200,
      );
    }

    throw new Error(`unexpected fetch to ${input}`);
  };
}

export function makeRuntime(
  options: {
    config?: Partial<DropConfig>;
    env?: Partial<Env>;
    chain?: Partial<FakeChain>;
    store?: RevealStore;
  } = {},
): { runtime: Runtime; chain: FakeChain } {
  const chain: FakeChain = {
    totalSupply: 0,
    down: false,
    rpcCalls: 0,
    metadataCalls: 0,
    metadataDown: false,
    ...options.chain,
  };

  const env: Env = {
    RPC_URL,
    METADATA_HTTP_BASE_URL: METADATA_URL,
    ...options.env,
  };

  const runtime = createRuntime({
    config: baseConfig(options.config),
    env,
    fetchImpl: makeFakeFetch(chain),
    ...(options.store ? { store: options.store } : {}),
  });

  return { runtime, chain };
}

export function get(path: string): Request {
  return new Request(`https://drop.test${path}`);
}

function hexWord(value: number): string {
  return "0x" + value.toString(16).padStart(64, "0");
}

function jsonResponse(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

/** A KV namespace that records every write, for the coalescing tests. */
export function makeFakeKv(): KvLike & { writes: string[]; now: number } {
  const state = {
    writes: [] as string[],
    now: 1_000_000,
    value: null as string | null,
    async get(_key: string): Promise<string | null> {
      return state.value;
    },
    async put(_key: string, value: string): Promise<void> {
      state.writes.push(value);
      state.value = value;
    },
  };
  return state;
}

/**
 * A store that records nothing and fails every write, so a reveal that still
 * happens can only have come from the reader's own in-memory mark.
 */
export function makeBrokenStore(): RevealStore {
  return {
    kind: "broken",
    async getHighWater() {
      return null;
    },
    async bumpHighWater() {
      throw new Error("shared store is unavailable");
    },
    describe() {
      return "a store that always fails";
    },
  };
}
