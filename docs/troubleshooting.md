# Troubleshooting

> Symptoms, in rough order of how often they happen. Start with `/status` and
> preflight; almost everything below is diagnosed by one of the two.

```bash
curl -s https://your-server/status
npm run preflight -- --url https://your-server
```

`ok: false` comes with a `problems` array naming what is wrong. `ok: true` means
the server is fine and the problem is between the contract, the marketplace, and
a cache. Preflight also compares the server against the live contract.

## Every token shows the same image

`baseURI` has no trailing slash, so the contract returns that one URI for every
token. That is how a pre-reveal drop works, and the most common mistake here.

```bash
cast call <contract> "baseURI()(string)" --rpc-url $RPC_URL
cast send <contract> "setBaseURI(string)" "https://your-server/" --rpc-url $RPC_URL --private-key $KEY
```

## A token minted but still shows the placeholder

Check what the server thinks:

```bash
curl -sI https://your-server/41 | grep -i x-reveal-state
```

`unminted` means the server does not see the mint. Give it `ttlSeconds`, then
check `/status`. A stale `highestMintedTokenId` with no error usually means
`tokenIdStart` is wrong, so every token is off by one.

`rpc-unavailable` means the chain read failed and the server is withholding on
purpose. `mintState.lastError` at `/status` says why.

`metadata-missing` means the server sees the mint but has nothing to serve.
Either the manifest is smaller than the drop, or the shuffle is on and
`SHUFFLE_SEED` is not set. `/status` says which.

`error` means the metadata source failed, for example a bucket returning a 5xx or
holding unparseable JSON. `mintState.lastError` has the detail, and the source is
retried on the next request rather than remembered as broken.

`minted` means the server is doing its job and something downstream is caching.
OpenSea reads `tokenURI` when it indexes a mint, so a token indexed while the
placeholder was live keeps that record until refreshed:

```bash
OPENSEA_API_KEY=... npm run refresh -- --from 41 --to 41
```

If your own site shows the placeholder but `curl` shows the real metadata, the
difference is a browser or CDN cache in between.

## The newest minted tokens are stuck, and someone has burned one

`totalSupply()` on ERC721A is minted minus burned, so on a contract exposing only
that number, one burn hides the highest minted token until another mint replaces
it. Check which read the server is using:

```bash
curl -s https://your-server/status | grep supplyReader
```

`mint-stats` means it is reading `getMintStats`, which burns do not affect, so
this is not your problem. `total-supply` means the contract has no `getMintStats`
and the drop is exposed. Run a webhook so mints arrive by exact ID
([webhooks.md](webhooks.md)), or use `mintState.mode: "ownerOf"`.

## The placeholder is stuck, for a while, on lots of tokens

Something is caching unrevealed responses. Confirm the header:

```bash
curl -sI https://your-server/9999 | grep -i cache-control
```

It should include `max-age=0` and `must-revalidate`; the full table is in
[how-it-works.md](how-it-works.md#the-cache-rules). If it does not,
`cache.unrevealedMaxAge` has been raised in `drop.config.ts`. Set it back to 0.

If the header is right, look for a cache rule in front of the server: a
Cloudflare cache rule, a CDN in front of Vercel, or a "cache everything" page
rule. Those override the origin.

## The server 500s with a configuration problem

The body names the field. Fix `drop.config.ts` and redeploy; the same check runs
locally and faster with `npm run dev`.

## `npm run dev` exits immediately

It prints the reason and exits 1. On a fresh clone that is the placeholder
contract address, deliberately: a server answering requests while pointed at
`0x000...` would be worse than one that refuses to start.

A syntax error on a `.ts` file instead means your Node is older than 22.18, which
is where running TypeScript directly stopped needing a flag.

## Reveals are slower than ten seconds

A serverless host runs many instances, each with its own timer, so a request
landing on a cold one waits for a fresh read. In order of effort: lower
`ttlSeconds` to 5, add a webhook, or add a webhook plus a KV store. See
[webhooks.md](webhooks.md), which is also honest about how little KV buys you.

## Reveals are too fast, or a token revealed early

Raise `mintState.confirmations`. The default of 0 reveals as soon as a mint is
visible at the chain tip, which can be a block that later reorgs out. Since a
token's artwork is fixed by its ID, that only ever means a few seconds early,
never the wrong artwork.

If a token revealed that has definitely not minted and you run a webhook, a
delivery claimed it did: check `mintState.webhookMints`. The high water mark only
rises, so restarting the server is the only way back down.

## `/webhook/mint` returns 400 on `revealedThrough`

That field means "everything up to this ID is minted", which only makes sense in
`sequential` mode. In `ownerOf` mode the server refuses it rather than revealing
token n alone and silently dropping the rest of what you meant. Send the
individual ids as `tokenIds: [...]`.

## `/webhook/alchemy` returns 404 or 401

404 means the route does not exist yet: it appears once
`ALCHEMY_WEBHOOK_SIGNING_KEY` is set, and the same goes for `/webhook/mint` and
`WEBHOOK_SECRET`. That is deliberate, so a default deployment has no
unauthenticated write surface.

401 means the signature did not match, so the signing key is not the one for this
webhook. Each webhook in the Alchemy dashboard has its own key and it is easy to
copy the wrong one. Re-copy from the webhook's detail page.

## `build:manifest` stops on the metadata set

It found an order it could not trust, and stopping is deliberate: position
decides which artwork each token gets, and nothing can change that after a mint.
The message names the specific problem, and
[metadata/README.md](../metadata/README.md) lists what it checks and how to fix
each one.

## Rate limited by the RPC endpoint

You are on a shared public endpoint. Set `RPC_URL` to your own; any provider
works. In `sequential` mode the call rate does not depend on traffic, so being
limited at all means either the shared endpoint or `ownerOf` mode on a heavily
indexed drop.

## A token 404s

It is outside `tokenIdStart` to `tokenIdStart + maxSupply - 1`. The 404 body
prints the range it accepted. If that disagrees with the contract,
`npm run preflight` says so.

## Nothing above matches

`/status` is safe to share, since it contains no secrets. Include it in an issue
along with the `x-reveal-state` and `cache-control` headers for one misbehaving
token, and what `cast call <contract> "tokenURI(uint256)(string)" <id>` returns
for it.
