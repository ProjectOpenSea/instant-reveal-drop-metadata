/**
 * Wires the pieces together once, when the server starts.
 *
 * Every adapter (Cloudflare, Vercel, Node) builds one of these and hands it to
 * the request handler, which keeps the handler easy to test: the tests build a
 * runtime with a fake RPC endpoint and never touch the network.
 */

import { resolveConfig, type DropConfig, type ResolvedConfig } from "./config.ts";
import { envFlag, type Env } from "./env.ts";
import { resolveRpcUrl } from "./chains.ts";
import { MintStateReader } from "./mint-state.ts";
import { createKvRevealStore, createMemoryRevealStore, type RevealStore } from "./reveal-store.ts";
import { RpcClient, type FetchLike } from "./rpc.ts";
import { createMetadataSource, type MetadataSource } from "./sources/index.ts";
import { MANIFEST_HASH } from "./generated/manifest.ts";
import { TokenMetadataBuilder } from "./token-metadata.ts";

export type Runtime = {
  config: ResolvedConfig;
  env: Env;
  source: MetadataSource;
  builder: TokenMetadataBuilder;
  mintState: MintStateReader;
  store: RevealStore;
  revealAll: boolean;
  publishSeed: boolean;
  seed: string | undefined;
  manifestHash: string;
  rpcUrl: string;
  startedAtMs: number;
};

export type CreateRuntimeOptions = {
  config: DropConfig;
  env: Env;
  /** Injected by the tests. Production uses global fetch. */
  fetchImpl?: FetchLike;
  /** Injected by the tests, so nothing depends on wall clock ordering. */
  store?: RevealStore;
};

export function createRuntime(options: CreateRuntimeOptions): Runtime {
  const config = resolveConfig(options.config);
  const env = options.env;

  const rpcUrl = resolveRpcUrl(config.chain, env.RPC_URL);
  const client = new RpcClient({ url: rpcUrl, fetchImpl: options.fetchImpl });

  const store =
    options.store ??
    (env.REVEAL_STATE ? createKvRevealStore(env.REVEAL_STATE) : createMemoryRevealStore());

  const source = createMetadataSource(config, env, options.fetchImpl);
  const seed = env.SHUFFLE_SEED;

  return {
    config,
    env,
    source,
    builder: new TokenMetadataBuilder(config, source, seed),
    mintState: new MintStateReader(config, client, store),
    store,
    revealAll: envFlag(env.REVEAL_ALL),
    publishSeed: envFlag(env.PUBLISH_SEED),
    seed,
    manifestHash: config.metadata.manifestHash ?? MANIFEST_HASH,
    rpcUrl,
    startedAtMs: Date.now(),
  };
}

/** Host name only, so /status never echoes an RPC URL that contains an API key. */
export function rpcHost(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return "(unparseable RPC_URL)";
  }
}
