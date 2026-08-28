/**
 * Metadata read from a private HTTP base URL, one file per token position.
 *
 * Suitable for a private S3 or GCS bucket, or any host that requires a header
 * this server can send and the public cannot guess. Set:
 *
 *   METADATA_HTTP_BASE_URL        https://my-bucket.example.com/drop
 *   METADATA_HTTP_AUTHORIZATION   optional, sent as the Authorization header
 *
 * One warning. A public IPFS gateway is not a private base URL. If your set is
 * pinned publicly, anyone can list the directory and the gating this server
 * does becomes decorative. Either keep the set private, or turn on the shuffle
 * so the public set cannot be mapped to token IDs.
 */

import type { ResolvedConfig, TokenMetadata } from "../config.ts";
import type { Env } from "../env.ts";
import type { FetchLike } from "../rpc.ts";
import { createIndexLoader, type MetadataSource, renderPath } from "./index.ts";

export function createHttpSource(
  config: ResolvedConfig,
  env: Env,
  fetchImpl?: FetchLike,
): MetadataSource {
  const base = (env.METADATA_HTTP_BASE_URL ?? "").replace(/\/+$/, "");
  const authorization = env.METADATA_HTTP_AUTHORIZATION;
  const template = config.metadata.pathTemplate;
  const doFetch: FetchLike = fetchImpl ?? ((input, init) => fetch(input, init));

  const load = createIndexLoader<TokenMetadata>(async (index) => {
    const url = `${base}/${renderPath(template, index)}`;
    const response = await doFetch(url, {
      headers: authorization ? { authorization } : undefined,
      signal: AbortSignal.timeout(5_000),
    });
    if (response.status === 404) return null;
    if (!response.ok) {
      throw new Error(`metadata source returned HTTP ${response.status} for index ${index}`);
    }
    return (await response.json()) as TokenMetadata;
  });

  return {
    kind: "http",
    async get(index: number) {
      if (!base) return null;
      return load(index);
    },
    size() {
      return null;
    },
    ready() {
      return base.length > 0;
    },
    describe() {
      if (!base) return "http selected but METADATA_HTTP_BASE_URL is not set";
      const host = safeHost(base);
      return `http source at ${host}, path template ${template}${authorization ? ", authenticated" : ""}`;
    },
  };
}

/** Report the host only. A base URL can carry a token in its path. */
function safeHost(base: string): string {
  try {
    return new URL(base).host;
  } catch {
    return "(unparseable METADATA_HTTP_BASE_URL)";
  }
}
