/**
 * Metadata compiled into the deployment. The default, and the simplest thing
 * that works: one `npm run build:manifest`, one deploy, no storage to set up
 * and nothing else that can be down while your mint is live.
 *
 * Cloudflare Workers caps a compressed bundle at 3 MB on the free plan and
 * 10 MB on the paid one. Metadata JSON compresses well, so this comfortably
 * covers a few thousand tokens. `npm run build:manifest` prints the size and
 * tells you if you are close.
 */

import { MANIFEST, MANIFEST_BUILT_AT, MANIFEST_HASH } from "../generated/manifest.ts";
import type { MetadataSource } from "./index.ts";

export function createBundledSource(): MetadataSource {
  return {
    kind: "bundled",
    async get(index: number) {
      return MANIFEST[index] ?? null;
    },
    size() {
      return MANIFEST.length;
    },
    ready() {
      return MANIFEST.length > 0;
    },
    describe() {
      if (MANIFEST.length === 0) {
        return "bundled manifest is empty, run `npm run build:manifest`";
      }
      return `bundled manifest, ${MANIFEST.length} entries, hash ${MANIFEST_HASH.slice(0, 12)}, built ${MANIFEST_BUILT_AT}`;
    },
  };
}

export { MANIFEST_HASH };
