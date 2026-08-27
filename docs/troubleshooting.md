# Troubleshooting

Start here:

```bash
curl -s https://your-server/status
```

`ok: false` comes with a `problems` array naming what is wrong. `ok: true` means
the server is fine and the problem is between the contract, the marketplace, and
a cache.

Then run the checker, which compares the server against the live contract:

```bash
npm run preflight -- --url https://your-server
```

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

`error` means the metadata source itself failed, for example a bucket returning a
5xx or holding unparseable JSON. The placeholder is served rather than a 500 so
marketplaces do not record a broken token, and `mintState.lastError` has the
detail.

`minted` means the server is doing its job and something downstream is caching.
OpenSea reads `tokenURI` when it indexes a mint, so a token indexed while the
placeholder was live keeps that record until refreshed:

```bash
OPENSEA_API_KEY=... npm run refresh -- --from 41 --to 41
```

If your own site is showing the placeholder but `curl` shows the real metadata,
the difference is a browser or CDN cache in between.

## The placeholder is stuck, for a while, on lots of tokens

Something is caching unrevealed responses. Confirm the header:

```bash
curl -sI https://your-server/9999 | grep -i cache-control
```

It should include `max-age=0` and `must-revalidate`. If it does not,
`cache.unrevealedMaxAge` has been raised in `drop.config.ts`. Set it back to 0.

If the header is right but placeholders persist, look for a cache rule in front
of the server: a Cloudflare cache rule, a CDN in front of Vercel, or a "cache
everything" page rule. Those override the origin.

## The server 500s with a configuration problem

The body names the field:

```json
{ "error": "configuration problem", "detail": "drop.config.ts is not usable yet: ..." }
```

Fix `drop.config.ts` and redeploy. The same check runs locally, faster:

```bash
npm run dev
```

## `npm run dev` exits immediately

It prints the reason and exits 1. On a fresh clone that is the placeholder
contract address, deliberately: a server answering requests while pointed at
`0x000...` would be worse than one that refuses to start.

If it fails before that with a syntax error on a `.ts` file, your Node is older
than 22.18, which is where running TypeScript directly stopped needing a flag.

## Reveals are slower than ten seconds

`mintState.ttlSeconds` is the floor on how late a reveal can be, but a serverless
host runs many instances, each with its own timer, so a request landing on a cold
instance waits for a fresh read. In order of effort: lower `ttlSeconds` to 5, add
a webhook, or add a webhook plus a KV store so instances share progress. See
[webhooks.md](webhooks.md).

## Reveals are too fast, or a token revealed early

Raise `mintState.confirmations`. The default of 0 reveals as soon as a mint is
visible at the chain tip, which can be a block that later reorgs out. Because a
token's artwork is fixed by its ID, that only ever means a token was revealed a
few seconds early, never that it showed the wrong artwork.

If a token revealed that has definitely not minted, and you run a webhook, a
delivery claimed it did. Check `mintState.webhookMints` at `/status`. The high
water mark only rises, so restarting the server is the only way back down. In
`sequential` mode a delivery for a high ID reveals everything below it, which is
correct for SeaDrop and wrong for a contract that mints out of order: use
`ownerOf` mode there.

## Rate limited by the RPC endpoint

You are on a shared public endpoint. Set `RPC_URL` to your own. Any provider works.

In `sequential` mode the call rate does not depend on traffic, so being limited
at all means either the shared endpoint or `ownerOf` mode on a heavily indexed
drop.

## `/webhook/alchemy` returns 404

The route does not exist until `ALCHEMY_WEBHOOK_SIGNING_KEY` is set. Same for
`/webhook/mint` and `WEBHOOK_SECRET`. That is deliberate, so a default deployment
has no unauthenticated write surface.

## `/webhook/alchemy` returns 401

The signature did not match, so the signing key is not the one for this webhook.
Each webhook in the Alchemy dashboard has its own key and it is easy to copy the
wrong one. Re-copy from the webhook's detail page.

## A token 404s

It is outside `tokenIdStart` to `tokenIdStart + maxSupply - 1`. The 404 body
prints the range it accepted. If that disagrees with the contract, preflight says
so:

```bash
npm run preflight
```

## Nothing above matches

`/status` is safe to share, since it contains no secrets. Include it in an issue
along with the `x-reveal-state` and `cache-control` headers for one misbehaving
token, and what `cast call <contract> "tokenURI(uint256)(string)" <id>` returns
for it.
