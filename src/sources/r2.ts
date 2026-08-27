/**
 * Metadata read from a Cloudflare R2 bucket, one object per token position.
 *
 * Use this when your set is too large to bundle, or when you would rather your
 * metadata never sat in git. R2 buckets are private by default, so nothing is
 * readable except through this server.
 *
 * Setup is in `docs/large-drops.md`, and comes down to:
 *   npx wrangler r2 bucket create my-drop-metadata
 *   npx wrangler r2 object put my-drop-metadata/0.json --file metadata/0.json
 * plus the binding already present in wrangler.toml.
 */

import type { ResolvedConfig, TokenMetadata } from "../config.ts";
import type { Env } from "../env.ts";
import { renderPath, type MetadataSource } from "./index.ts";

export function createR2Source(config: ResolvedConfig, env: Env): MetadataSource {
  const bucket = env.METADATA_BUCKET;
  const template = config.metadata.pathTemplate;

  // Positive results are immutable, so one read per token per isolate is enough.
  const cache = new Map<number, TokenMetadata>();

  return {
    kind: "r2",
    async get(index: number) {
      if (!bucket) return null;
      const cached = cache.get(index);
      if (cached) return cached;

      const object = await bucket.get(renderPath(template, index));
      if (!object) return null;

      const parsed = JSON.parse(await object.text()) as TokenMetadata;
      cache.set(index, parsed);
      return parsed;
    },
    size() {
      return null;
    },
    ready() {
      return Boolean(bucket);
    },
    describe() {
      return bucket
        ? `r2 bucket via METADATA_BUCKET binding, key template ${template}`
        : "r2 selected but no METADATA_BUCKET binding is present";
    },
  };
}
