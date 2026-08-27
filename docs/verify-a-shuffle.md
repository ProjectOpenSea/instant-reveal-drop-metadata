# Verifying a shuffle

For a holder who wants to check the creator did not reorder the good pieces, and
for a creator who wants to be able to prove it.

## What was promised

Before the mint opened, the creator published two hashes:

```
manifestHash   sha256("instant-reveal-manifest-v1:" + canonicalJson(metadataSet))
commitment     sha256("instant-reveal-seed-v1:" + seed)
```

The first fixes the set of artwork, the second fixes the mapping without
revealing it. Both are served at `/provenance`, and normally posted wherever the
drop was announced. After the mint the creator publishes the seed itself.

With those three values and the metadata set, anyone can recompute the mapping
and compare it to what was served.

## The algorithm

Written out so an independent implementation can reproduce it:

1. `key = SHA-256(utf8(seed))`, 32 bytes.
2. `state` is the first 8 bytes of `key` read as a big endian unsigned 64 bit
   integer.
3. Random numbers come from splitmix64, the reference implementation, all
   arithmetic modulo 2^64:
   ```
   state = state + 0x9E3779B97F4A7C15
   z = state
   z = (z XOR (z >> 30)) * 0xBF58476D1CE4E5B9
   z = (z XOR (z >> 27)) * 0x94D049BB133111EB
   return z XOR (z >> 31)
   ```
4. Start from the identity permutation over `[0, n)` where `n` is `maxSupply`.
5. Fisher-Yates, walking `i` from `n - 1` down to `1`. Each `j` is drawn
   uniformly from `[0, i]` by rejection sampling: with `bound = i + 1` and
   `limit = 2^64 - (2^64 mod bound)`, draw until the value is below `limit`, then
   take it modulo `bound`. Swap positions `i` and `j`.
6. `permutation[position]` is the index into the metadata set for the token at
   that position, where `position = tokenId - tokenIdStart`.

The implementation is [`src/shuffle.ts`](../src/shuffle.ts), with a test pinning
a known mapping so an upgrade cannot silently change it.

## A standalone script

Depends on nothing but Node. Save it as `verify.mjs`:

```js
import { createHash } from "node:crypto";

const U64 = (1n << 64n) - 1n;
const TWO64 = 1n << 64n;

const sha256 = (text) => createHash("sha256").update(text, "utf8").digest("hex");

function splitmix64(seedValue) {
  let state = seedValue & U64;
  return () => {
    state = (state + 0x9e3779b97f4a7c15n) & U64;
    let z = state;
    z = ((z ^ (z >> 30n)) * 0xbf58476d1ce4e5b9n) & U64;
    z = ((z ^ (z >> 27n)) * 0x94d049bb133111ebn) & U64;
    return (z ^ (z >> 31n)) & U64;
  };
}

function below(next, bound) {
  if (bound <= 1n) return 0n;
  const limit = TWO64 - (TWO64 % bound);
  let value = next();
  while (value >= limit) value = next();
  return value % bound;
}

export function permutation(seed, size) {
  const next = splitmix64(BigInt("0x" + sha256(seed).slice(0, 16)));
  const order = Array.from({ length: size }, (_, i) => i);
  for (let i = size - 1; i > 0; i--) {
    const j = Number(below(next, BigInt(i + 1)));
    [order[i], order[j]] = [order[j], order[i]];
  }
  return order;
}

// --- usage -----------------------------------------------------------------

const seed = process.argv[2];
const size = Number(process.argv[3]);
const tokenIdStart = Number(process.argv[4] ?? 1);

console.log("commitment  ", sha256("instant-reveal-seed-v1:" + seed));
const order = permutation(seed, size);
for (let position = 0; position < Math.min(size, 20); position++) {
  console.log(`token ${tokenIdStart + position} -> metadata index ${order[position]}`);
}
```

Run it:

```bash
node verify.mjs "the-published-seed" 1000 1
```

If the commitment it prints matches the one published before the mint, this seed
is the seed that was committed to. Then check a few mappings against what the
collection shows: metadata index 41 is the 42nd entry of the published set.

## Checking the known mapping

With seed `instant-reveal-golden-seed` and size 16, the mapping is:

```
[2, 4, 7, 0, 15, 14, 3, 6, 9, 8, 11, 13, 12, 10, 1, 5]
```

If you get that, your implementation agrees with this one.

## Checking the metadata set

The manifest hash covers the whole set in upload order, with object keys sorted so
that reformatting the JSON does not change the hash:

```js
function canonicalJson(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const entries = Object.entries(value)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`);
  return `{${entries.join(",")}}`;
}

const manifestHash = sha256("instant-reveal-manifest-v1:" + canonicalJson(metadataSet));
```

Where `metadataSet` is the array of metadata objects in upload order. If it
matches the published `manifestHash`, no artwork was swapped after the
commitment.

## What this proves, and what it does not

It proves the mapping came from a seed committed to before the mint, and that the
artwork set was not changed after the commitment.

It does not prove the creator chose the seed blindly, only that they were locked
in before minting started. A creator could generate many seeds, pick the mapping
they liked, and commit to that one. Committing before the art is finalised, or
deriving the seed from a future block hash, closes that gap. For most drops the
commitment is enough: the interesting cheat is reassigning rares to your own
wallet mid-mint, and a commitment makes that impossible.
