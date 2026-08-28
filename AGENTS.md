# Agent instructions

A self-hosted metadata server for OpenSea Studio (SeaDrop) drops. It reveals each
token the moment its mint is visible onchain and serves a placeholder for
everything unminted, so a creator can point their contract's `baseURI` at it
instead of at IPFS until the mint is over.

Read this file first. The long-form docs in `docs/` explain the same system to
creators and are not needed for orientation.

## Architecture

```
adapters/cloudflare.ts  \
api/index.ts (Vercel)    ->  src/runtime.ts  ->  src/handler.ts
adapters/node.ts        /                            |
                                                     |-- src/mint-state.ts -> src/rpc.ts -> chain
                                                     |-- src/token-metadata.ts -> src/shuffle.ts
                                                     `-- src/sources/{bundled,r2,http}.ts
```

- `src/handler.ts` is the entire HTTP surface and the only place cache headers
  are set. It takes a `Request` plus a `Runtime` and returns a `Response`.
- `src/runtime.ts` wires everything once per process; each adapter builds one
  from its platform's environment.
- `src/mint-state.ts` answers "is this token minted", by polling
  (`sequential`, one mint-count read per TTL) or per token (`ownerOf`).
- `src/reveal-store.ts` shares the high water mark between instances (memory or
  Cloudflare KV).
- `src/sources/` fetch metadata by zero-based index. `src/token-metadata.ts`
  maps token ID to that index, through the shuffle when it is on.
- `scripts/` are Node-only tools: `preflight`, `build-manifest`, `export`,
  `seed`, `refresh-opensea`, and the two `check:*` guards.

## Invariants

Do not break these. Each one has a test.

1. **Fail closed.** Any failure (RPC, metadata source, decode, throttle) serves
   the placeholder, never real metadata and never a cacheable error. Late
   reveals are acceptable, early ones are not.
2. **Cacheability.** A revealed token is cacheable forever; an unrevealed answer
   must never be cacheable. Set in `src/handler.ts` only.
3. **Never un-mint.** Once a token is known minted it stays minted. Burns lower
   `totalSupply()`, and load-balanced RPCs answer from old blocks.
4. **Artwork is a pure function of token ID**, through the seeded permutation
   when the shuffle is on. Never time-dependent or minter-dependent. Do not
   change the shuffle algorithm: published commitments depend on it, and
   `test/shuffle.test.ts` pins a known mapping.
5. **`src/` runs on Workers, Vercel edge, and Node.** Node APIs belong in
   `adapters/` and `scripts/`. `npm run check:worker` enforces this.
6. **Zero runtime dependencies**, deliberately. Do not add any. A new dev
   dependency needs a reason, and versions are pinned exactly.
7. **The refuse-to-guess stance is load-bearing.** `orderMetadataFiles` in
   `scripts/shared.ts` errors rather than infer a metadata order, and
   `check:privacy` blocks unrevealed metadata reaching git. Extend them, never
   soften them.

## Commands

```bash
npm run ci            # everything below, and what CI runs
npm run lint          # biome, lint and format (lint:fix applies)
npm run typecheck     # tsc --noEmit
npm test              # node --test, no network and no chain
npm run check:privacy # no unrevealed metadata staged or committed
npm run check:worker  # src/ still bundles for Cloudflare Workers
```

`npm run ci` is the gate. CI runs it on the Node floor from `engines.node`, so
passing locally on a newer Node is not proof.

## Conventions

- TypeScript run directly by Node, no build step. Node 22.18+.
- Tests use `node:test` and `node:assert/strict`, and never touch the network:
  `test/helpers.ts` provides a fake chain and a fake metadata host. Add knobs
  there rather than mocking modules.
- Comments explain **why**, not what. Most of the value in this repository is
  the reasoning next to the code; match that voice and density.
- No em dashes. Straight quotes. Sentence case in headings.
- Prefer a test that fails before your fix. Several existing tests were written
  by reverting the fix to confirm they catch it.

## Chain facts this depends on

Verified against live Studio contracts on Base.

- Studio deploys `ERC721SeaDropCloneable` (ERC721A). Token IDs start at 1 and
  are minted in order.
- `baseURI` ending in `/` is what "revealed" means to the contract; `tokenURI`
  then returns `baseURI + decimal tokenId`, no `.json`. Without the slash every
  token returns that same URI, which is how a pre-reveal drop works.
- An unminted token reverts: `tokenURI` with `URIQueryForNonexistentToken()`,
  `ownerOf` with `OwnerQueryForNonexistentToken()`.
- `totalSupply()` is minted minus burned. `getMintStats(address)` returns
  `_totalMinted()` as its second value, which burns do not lower, so
  `sequential` mode prefers it and falls back when it reverts.
- The public `totalMinted()` some ERC721A forks expose is **not** on these
  contracts; calling it reverts.

## Before opening a PR

- `npm run ci` passes.
- New behaviour has a test; a bug fix has a test that fails without the fix.
- No new runtime dependency.
- Cache headers unchanged, or the change is deliberate and tested.
- If you touched `src/`, `check:worker` passed (it needs `npm ci` first, since
  wrangler is a pinned devDependency).
- If you changed the reveal decision, say in the PR which direction a failure
  now errs in.
