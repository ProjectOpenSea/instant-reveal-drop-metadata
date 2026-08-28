/**
 * Where the real metadata comes from. Pick one with `metadata.source` in
 * `drop.config.ts`.
 *
 * All three answer the same question: give me the metadata at position N of my
 * set, where N is zero based. Which token ID position N belongs to is decided
 * elsewhere (see `src/token-metadata.ts`), because the shuffle sits in between.
 */

import type { ResolvedConfig, TokenMetadata } from "../config.ts";
import type { Env } from "../env.ts";
import type { FetchLike } from "../rpc.ts";
import { createBundledSource } from "./bundled.ts";
import { createHttpSource } from "./http.ts";
import { createR2Source } from "./r2.ts";

export type MetadataSource = {
  readonly kind: string;
  /** null means "no metadata at that position", which is served as a placeholder. */
  get(index: number): Promise<TokenMetadata | null>;
  /** How many entries the source holds, when it knows. */
  size(): number | null;
  /** False when the source is not usable yet, for example an unbuilt manifest. */
  ready(): boolean;
  /** A one line summary for /status. Must never include a secret. */
  describe(): string;
};

export function createMetadataSource(
  config: ResolvedConfig,
  env: Env,
  fetchImpl?: FetchLike,
): MetadataSource {
  switch (config.metadata.source) {
    case "bundled":
      return createBundledSource();
    case "r2":
      return createR2Source(config, env);
    case "http":
      return createHttpSource(config, env, fetchImpl);
    default: {
      const kind: string = config.metadata.source;
      throw new Error(`Unknown metadata.source "${kind}". Use "bundled", "r2", or "http".`);
    }
  }
}

/**
 * Remember loads, not just results, so a burst of requests for one index makes
 * one upstream call rather than one each.
 *
 * The burst is the normal case rather than an edge case: the moment a token
 * reveals, every marketplace, wallet and indexer watching the contract asks for
 * it at once, and they all miss the empty cache together. Caching only the
 * settled value leaves that whole first wave hitting the upstream in parallel.
 *
 * Two results are deliberately not kept.
 *
 *   a rejection   a bad gateway is a moment, not a fact about the index, and
 *                 caching it would turn one blip into a permanent placeholder
 *   a null        "nothing at that position" is usually a file that has not
 *                 been uploaded yet, and the same argument applies
 *
 * Anything that did resolve to metadata is kept forever, which is correct: a
 * metadata set is fixed before the mint opens, and the manifest hash published
 * at /provenance is a promise that it does not change afterwards.
 */
export function createIndexLoader<T>(
  load: (index: number) => Promise<T | null>,
): (index: number) => Promise<T | null> {
  const entries = new Map<number, Promise<T | null>>();

  return (index: number): Promise<T | null> => {
    const existing = entries.get(index);
    if (existing) return existing;

    const pending = load(index);
    entries.set(index, pending);
    pending.then(
      (value) => {
        if (value === null) entries.delete(index);
      },
      () => entries.delete(index),
    );
    return pending;
  };
}

/** Fill `{index}` in a path template. */
export function renderPath(template: string, index: number): string {
  return template.replaceAll("{index}", String(index));
}
