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

/** Fill `{index}` in a path template. */
export function renderPath(template: string, index: number): string {
  return template.replaceAll("{index}", String(index));
}
