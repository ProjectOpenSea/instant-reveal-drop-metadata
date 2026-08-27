/**
 * Optional token-to-artwork shuffle, and the hashes that let a holder check
 * you played fair.
 *
 * Without a shuffle, token 1 gets the first file you uploaded, token 2 the
 * second, and so on. That is fine as long as your metadata set stays private,
 * but it means holders have to take your word for it.
 *
 * With a shuffle you publish two hashes before the mint opens:
 *
 *   manifestHash  a hash of your complete metadata set, so you cannot swap
 *                 artwork in later
 *   commitment    a hash of a secret seed, so you cannot reorder the mapping
 *                 after seeing who minted what
 *
 * After the mint you publish the seed. Anyone can then recompute the exact
 * mapping and confirm it matches what the server served all along.
 *
 * The algorithm below is specified precisely so an independent implementation
 * can reproduce it:
 *
 *   1. key    = SHA-256(utf8(seed))
 *   2. state  = big-endian uint64 of key[0..7]
 *   3. random = splitmix64(state), the reference implementation, mod 2^64
 *   4. order  = Fisher-Yates over [0, n), walking i from n-1 down to 1, with
 *              j drawn uniformly from [0, i] by rejection sampling
 *
 * `docs/verify-a-shuffle.md` has a standalone script that does the same thing.
 */

const U64 = (1n << 64n) - 1n;
const GOLDEN_GAMMA = 0x9e3779b97f4a7c15n;

export function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

export async function sha256Hex(data: string | Uint8Array): Promise<string> {
  const bytes = typeof data === "string" ? new TextEncoder().encode(data) : data;
  const digest = await crypto.subtle.digest("SHA-256", bytes as unknown as ArrayBuffer);
  return bytesToHex(new Uint8Array(digest));
}

/**
 * The value you publish before the mint. Revealing the seed later lets anyone
 * recompute this and see it matches.
 */
export function seedCommitment(seed: string): Promise<string> {
  return sha256Hex(`instant-reveal-seed-v1:${seed}`);
}

/** JSON with object keys sorted, so hashing the same data twice agrees. */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`);
  return `{${entries.join(",")}}`;
}

/** A hash over your whole metadata set, in upload order. */
export function manifestHash(entries: readonly unknown[]): Promise<string> {
  return sha256Hex(`instant-reveal-manifest-v1:${canonicalJson(entries)}`);
}

class SplitMix64 {
  private state: bigint;
  constructor(seed: bigint) {
    this.state = seed & U64;
  }
  next(): bigint {
    this.state = (this.state + GOLDEN_GAMMA) & U64;
    let z = this.state;
    z = ((z ^ (z >> 30n)) * 0xbf58476d1ce4e5b9n) & U64;
    z = ((z ^ (z >> 27n)) * 0x94d049bb133111ebn) & U64;
    return (z ^ (z >> 31n)) & U64;
  }
  /** Uniform in [0, bound). Rejection sampling, so there is no modulo bias. */
  below(bound: bigint): bigint {
    if (bound <= 1n) return 0n;
    const limit = (1n << 64n) - ((1n << 64n) % bound);
    let value = this.next();
    while (value >= limit) value = this.next();
    return value % bound;
  }
}

/**
 * The mapping itself: `permutation[position]` is the index into your metadata
 * set for the token at that position (position 0 is `tokenIdStart`).
 */
export async function buildPermutation(seed: string, size: number): Promise<number[]> {
  if (size <= 0) return [];

  const keyHex = await sha256Hex(seed);
  const rng = new SplitMix64(BigInt(`0x${keyHex.slice(0, 16)}`));

  const permutation = Array.from({ length: size }, (_, i) => i);
  for (let i = size - 1; i > 0; i--) {
    const j = Number(rng.below(BigInt(i + 1)));
    const a = permutation[i] as number;
    const b = permutation[j] as number;
    permutation[i] = b;
    permutation[j] = a;
  }
  return permutation;
}
