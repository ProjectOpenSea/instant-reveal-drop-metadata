/**
 * Shared record of how far the mint has got.
 *
 * Two things write to it: the poller (a `totalSupply()` read every few seconds)
 * and the webhook (a push from your node provider the instant a mint lands).
 * Both do the same thing, raise a high water mark, so they cannot disagree in a
 * way that matters. Neither can ever lower it.
 *
 * Why a store at all: a serverless deployment runs many independent copies of
 * this code. A webhook arrives at exactly one of them. With the memory store
 * the other copies find out on their next poll, which is fine but wastes the
 * speed the webhook bought you. With the KV store they all see it at once.
 *
 *   memory  no setup, per-instance, fine for a single Node process
 *   kv      Cloudflare KV, shared across every instance
 */

export type KvLike = {
  get(key: string, options?: { cacheTtl?: number }): Promise<string | null>;
  put(key: string, value: string, options?: { expirationTtl?: number }): Promise<void>;
};

export type RevealStore = {
  readonly kind: string;
  /** Highest token ID known to be minted, or null if nothing is known yet. */
  getHighWater(): Promise<number | null>;
  /** Raise the mark. Never lowers it. */
  bumpHighWater(tokenId: number): Promise<void>;
  describe(): string;
};

const HIGH_WATER_KEY = "highWater";

export function createMemoryRevealStore(): RevealStore {
  let highWater: number | null = null;
  return {
    kind: "memory",
    async getHighWater() {
      return highWater;
    },
    async bumpHighWater(tokenId: number) {
      if (highWater === null || tokenId > highWater) highWater = tokenId;
    },
    describe() {
      return "in-memory, not shared between instances";
    },
  };
}

/**
 * Cloudflare KV. Reads are cached for a second inside each instance, so a busy
 * mint costs about one KV read per second per colo rather than one per request.
 *
 * KV is eventually consistent, which is the right trade here: a stale read is a
 * reveal that arrives a moment late, and the local high water mark and the
 * poller both cover it.
 */
export function createKvRevealStore(kv: KvLike): RevealStore {
  let cached: { value: number | null; atMs: number } | null = null;
  let local: number | null = null;

  return {
    kind: "kv",
    async getHighWater() {
      const now = Date.now();
      if (!cached || now - cached.atMs > 1_000) {
        const raw = await kv.get(HIGH_WATER_KEY, { cacheTtl: 60 });
        const parsed = raw === null ? null : Number.parseInt(raw, 10);
        cached = {
          value: Number.isFinite(parsed) ? (parsed as number) : null,
          atMs: now,
        };
      }
      if (local !== null && (cached.value === null || local > cached.value)) return local;
      return cached.value;
    },
    async bumpHighWater(tokenId: number) {
      if (local !== null && tokenId <= local) return;
      local = tokenId;
      const current = cached?.value ?? null;
      if (current !== null && tokenId <= current) return;
      await kv.put(HIGH_WATER_KEY, String(tokenId));
      cached = { value: tokenId, atMs: Date.now() };
    },
    describe() {
      return "Cloudflare KV, shared across instances";
    },
  };
}
