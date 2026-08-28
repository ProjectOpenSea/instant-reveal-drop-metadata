/**
 * Shared record of how far the mint has got.
 *
 * Two things write to it: the poller (a `totalSupply()` read every few seconds)
 * and the webhook (a push from your node provider the instant a mint lands).
 * Both do the same thing, raise a high water mark, so they cannot disagree in a
 * way that matters. Neither can ever lower it.
 *
 * Why a store at all: a serverless deployment runs many independent copies of
 * this code. A webhook arrives at exactly one of them. That copy reveals the
 * token immediately, from its own mark; the question is how the others find
 * out. With the memory store, on their next poll. With KV, sooner than that
 * some of the time, and never later.
 *
 * "Sooner some of the time" is the honest claim, and it is worth being precise
 * about because it decides whether KV is worth binding. KV reads are served
 * from a cache at the reading colo, and `cacheTtl` has a floor of 60 seconds,
 * so an instance that has already read the key can go on seeing the old value
 * for up to a minute after the write. Same colo and same cache entry, a
 * neighbour picks the write up quickly. A colo that cached the key a moment
 * before the write does not, until that entry expires.
 *
 * So the poller is the cross-instance floor, not KV: with the default
 * `mintState.ttlSeconds` of 10, no instance is more than about ten seconds
 * behind whatever KV is doing. KV takes the common case below that, and cannot
 * make anything worse, because the mark only ever rises.
 *
 * True instant sharing needs a single coordination point rather than a cache,
 * which on Cloudflare means a Durable Object. That is a dependency and a
 * deployment step this repository deliberately does not have, and the poller
 * already bounds the delay, so it is a note rather than a plan.
 *
 *   memory  no setup, per-instance, fine for a single Node process
 *   kv      Cloudflare KV, shared between instances within about a minute
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

/** Cloudflare KV accepts about one write per second to a single key. */
const KV_WRITE_INTERVAL_MS = 1_000;

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
 * mint costs about one KV read per second per instance rather than one per
 * request. Behind that, KV serves reads from its own cache at the colo, whose
 * TTL cannot be set below 60 seconds.
 *
 * KV is eventually consistent, which is the right trade here: a stale read is a
 * reveal that arrives a moment late, and the local high water mark and the
 * poller both cover it. Nothing here waits on KV to reveal a token.
 *
 * Writes to one key are limited to about one a second, and a fast mint bumps the
 * mark faster than that, so writes are coalesced. A bump inside the window
 * updates the local mark immediately and parks the value, and the next store
 * call past the window writes whatever the highest parked value turned out to
 * be. Dropping the intermediate writes is safe because the mark only rises, so
 * the write that does land supersedes every one it skipped.
 */
export function createKvRevealStore(kv: KvLike): RevealStore {
  let cached: { value: number | null; atMs: number } | null = null;
  let local: number | null = null;
  let pending: number | null = null;
  let lastWriteAtMs: number | null = null;

  async function flush(now: number): Promise<void> {
    if (pending === null) return;
    if (lastWriteAtMs !== null && now - lastWriteAtMs < KV_WRITE_INTERVAL_MS) return;

    const value = pending;
    pending = null;
    lastWriteAtMs = now;

    try {
      await kv.put(HIGH_WATER_KEY, String(value));
    } catch (error) {
      // Park it again. `bumpHighWater` returns early for anything at or below
      // the local mark, so a value dropped here is never re-parked by a later
      // bump: one failed write and this instance stops publishing its mark
      // entirely, silently, for the rest of the mint.
      //
      // A newer bump can have landed while the write was in flight, and that
      // one supersedes this, so keep the higher of the two.
      if (pending === null || value > pending) pending = value;
      throw error;
    }

    cached = { value, atMs: now };
  }

  return {
    kind: "kv",
    async getHighWater() {
      const now = Date.now();
      await flush(now);
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

      const known = cached?.value ?? null;
      if (known !== null && tokenId <= known) return;

      if (pending === null || tokenId > pending) pending = tokenId;
      await flush(Date.now());
    },
    describe() {
      return "Cloudflare KV, shared across instances";
    },
  };
}
