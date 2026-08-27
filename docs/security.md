# Security, and what is actually hidden

Read this before a real mint. It is short, and the last section is the one people
skip and then regret.

## The threat

Someone wants to know which token ID holds the good piece, before it is minted.

SeaDrop mints token IDs in order, so a minter cannot choose their token ID. That
sounds like it settles the question, but it does not: knowing the mapping lets you
watch `totalSupply` and mint at the moment the next ID is a rare one. The mapping
is the secret, and timing is the attack.

Publishing your metadata directory to IPFS before the mint hands over the mapping
completely. That is the problem this server exists to fix.

## What this server hides

Which artwork an unminted token ID will get.

That is the whole claim. Everything below is a thing it does not do.

## What it does not hide

The artwork itself. Your images can be public on IPFS, and normally are. An image
on its own does not say which token ID it belongs to.

The rarity distribution. Anyone can read what has minted so far, count the traits,
and work out what is left. Every reveal scheme has this property.

Anything already revealed. Once a token mints, its metadata is public and will be
archived by indexers immediately. There is no taking it back.

Your metadata set, if you publish it somewhere else. See the next section.

## The mistake to avoid

If your metadata set is readable in full, and the mapping is sequential, then the
gating this server does is decorative. Someone reads your set, counts positions,
and knows exactly which token gets what.

Three ways that happens:

You push your copy of this repository to a public GitHub repo after running
`npm run build:manifest`. The generated file `src/generated/manifest.ts` contains
every token's metadata. `metadata/` is gitignored for this reason, but the
generated file cannot be, because the deployment needs it. Keep your copy private,
or use `metadata.source: "r2"` so the metadata never enters git.

You pin the finished set to IPFS "just to have it ready". A CID that is pinned is
a CID that can be fetched, whether or not you told anyone.

You set `metadata.source: "http"` with a base URL that is not actually private, for
example a public gateway or a bucket with listing enabled.

## The shuffle, and why you might want it

Turning on `reveal.shuffle` breaks the link between position in your set and token
ID. It buys two things.

Your metadata set can be public without giving away the mapping, because knowing
the set tells you nothing about which token gets which entry.

Holders can check you did not cheat. Before the mint you publish two hashes:

```
manifestHash   a hash of your complete metadata set
commitment     a hash of the secret seed
```

After the mint you publish the seed. Anyone can recompute the mapping and confirm
it produces exactly what the server served. Without a commitment, nothing stops a
creator from reassigning the good pieces partway through a mint, and nothing lets
an honest creator prove they did not. See
[verify-a-shuffle.md](verify-a-shuffle.md).

```bash
npm run seed:new
```

Keep a copy of the seed somewhere other than the machine you are working on.
Losing it means you can never reveal: the server refuses to guess, because
guessing would serve the unshuffled order, which is both the wrong artwork and a
leak of the order the shuffle exists to hide.

## Secrets, and what each one can do

| Secret | If it leaks |
| --- | --- |
| `SHUFFLE_SEED` | Someone can compute the whole mapping, which is the thing you were hiding. Treat it like a private key until you publish it deliberately. |
| `ALCHEMY_WEBHOOK_SIGNING_KEY`, `WEBHOOK_SECRET` | Someone can reveal tokens earlier than you meant to. Nothing can be stolen and no mapping can change. |
| `RPC_URL` with an API key in it | Someone can spend your RPC quota. `/status` reports the host only, never the URL. |

None of these give anyone control of your contract. Nothing in this repository
holds or needs a wallet key. The one onchain action involved, `setBaseURI`, you
send yourself.

## Design choices that exist for safety

The server fails closed. No chain access, no reveal. An outage makes reveals late,
never early.

A token's artwork depends only on its ID, fixed before the mint. A reorg can
reveal one token a few seconds early, and cannot cause a token to show the wrong
artwork.

A reveal is one way. The high water mark only rises, so a burn, a lagging RPC
node, or a replayed webhook cannot un-reveal a token that buyers have already
seen.

Unrevealed responses are not cacheable, so no CDN can strand a placeholder on a
token that has minted.

`/status` and `/provenance` are safe to hand to anyone. Neither includes a secret,
and the seed appears at `/provenance` only when you set `PUBLISH_SEED=true`.

## Reporting something

Open an issue, or for anything you would rather not post publicly, use
GitHub's private vulnerability reporting on this repository.
