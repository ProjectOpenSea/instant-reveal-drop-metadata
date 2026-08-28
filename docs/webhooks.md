# Webhooks

Polling gets a reveal out within `mintState.ttlSeconds`, 10 seconds by default. A
webhook gets it out in about one, by having your node provider tell the server
about a mint instead of the server asking.

Polling keeps running underneath either way, so a webhook that is misconfigured,
rate limited, or silently dropped costs nothing. Treat it as an optimisation, not
a dependency.

Both routes return 404 until you set their secret, so an unconfigured deployment
has no unauthenticated write surface.

## What a webhook can and cannot do

It can raise the high water mark, which reveals tokens.

It cannot lower it, hide a token, or change which artwork a token maps to. A
duplicate, out of order, or replayed delivery is harmless.

That asymmetry is also the risk to understand: a leaked webhook secret buys an
attacker the ability to reveal your drop early, and nothing else. If you would
rather not carry that, leave webhooks off. Polling is at most ten seconds behind.

One caveat with `mintState.mode: "sequential"`. That mode treats one token ID as
a cursor, so a delivery for token 900 reveals 1 through 900. That is correct for
SeaDrop, which mints in order. If your contract can mint out of order, an
owner-minted reserve at the top of the range would reveal the whole drop, so use
`ownerOf` mode, which records the exact IDs a webhook names and nothing else.

## Alchemy

Alchemy signs each delivery, and the server verifies the signature before
believing anything in the body.

1. In the Alchemy dashboard, create a webhook of type NFT Activity for your
   contract on your chain.
2. Set the URL to `https://your-server/webhook/alchemy`.
3. Copy the signing key from the webhook's detail page.
4. Give it to the server:

```bash
npx wrangler secret put ALCHEMY_WEBHOOK_SIGNING_KEY
# or, locally, in .env:
# ALCHEMY_WEBHOOK_SIGNING_KEY=whsec_...
```

Then check it is on:

```bash
curl -s https://your-server/status | grep -A3 webhooks
```

Custom Webhooks work as well. The server reads token IDs out of whichever shape
arrives: `erc721TokenId` fields on activity entries, and raw `Transfer` logs from
a GraphQL webhook. Anything not for your contract is ignored. Address Activity
webhooks work too, though NFT Activity is the closer fit.

### Verifying a delivery yourself

The signature is `HMAC-SHA256(signing key, raw request body)`, hex encoded, in the
`x-alchemy-signature` header. To reproduce it:

```bash
printf '%s' "$BODY" | openssl dgst -sha256 -hmac "$SIGNING_KEY" -hex
```

## Any other provider

`POST /webhook/mint` takes a bearer token you choose and a small JSON body. Use
it for QuickNode, Moralis, Helius, your own indexer, or a shell loop.

```bash
npx wrangler secret put WEBHOOK_SECRET
```

Then any of these bodies work:

```jsonc
{ "tokenIds": [41, 42, 43] }   // these tokens are minted
{ "tokenId": 41 }              // this token is minted
{ "revealedThrough": 512 }     // everything up to 512 is minted
```

```bash
curl -X POST https://your-server/webhook/mint \
  -H "Authorization: Bearer $WEBHOOK_SECRET" \
  -H "content-type: application/json" \
  -d '{"revealedThrough": 512}'
```

The reply tells you what it did:

```json
{
  "ok": true,
  "source": "generic",
  "tokenIdsSeen": 1,
  "tokenIdsApplied": 1,
  "revealedThrough": 512
}
```

`tokenIdsApplied` counts the IDs inside your drop's range. If it comes back 0,
they were outside `tokenIdStart` to `tokenIdStart + maxSupply - 1`, and you
probably have `tokenIdStart` wrong.

## Serverless hosts need one more step

Cloudflare and Vercel run many independent copies of your code, and a delivery
arrives at one of them. That copy reveals the token straight away. The others
find out on their next poll unless you give them somewhere shared to look.

On Cloudflare, bind a KV namespace:

```bash
npx wrangler kv namespace create REVEAL_STATE
```

Put the id in the `kv_namespaces` block of `wrangler.toml` and redeploy.
`/status` will show `revealStore: Cloudflare KV, shared across instances`.

A single Node process needs none of this, since there is only one copy.

### What KV does and does not buy you

It is worth being exact here, because the obvious reading is wrong. KV does not
hand the write to every instance at once. Reads are served from a cache at the
reading colo whose TTL cannot be set below 60 seconds, so an instance that read
the key just before your webhook landed can go on seeing the old value for up to
a minute.

So the poller, not KV, is what bounds how far behind an instance can be: with the
default `mintState.ttlSeconds` of 10, nobody is more than about ten seconds late.
KV takes the common case below that and can never make it worse, because the mark
only rises. Binding it is worth doing; expecting it to be instant is not.

True instant sharing needs a single coordination point rather than a cache, which
on Cloudflare means a Durable Object. This repository does not use one: it is a
dependency and a deployment step, and the poller already bounds the delay.

KV allows about one write per second per key, and a fast mint raises the mark
faster than that, so writes are coalesced: only the newest value is written, and
the ones it skipped are superseded by it. If KV is unreachable the delivery still
succeeds, because the reveal itself comes from the instance's own copy of the
mark, and the value is kept for the next write rather than dropped. `/status`
reports the failure under `mintState.lastError`.

## Checking it is working

`/status` counts deliveries and timestamps the last one:

```json
"mintState": {
  "mode": "sequential",
  "store": "kv",
  "highestMintedTokenId": 512,
  "lastPollAt": "2026-08-27T20:14:02.000Z",
  "lastWebhookAt": "2026-08-27T20:14:44.000Z",
  "webhookMints": 512
}
```

If `lastWebhookAt` stays null during a mint, deliveries are not arriving. Check
the provider's delivery log first, then the URL for a typo, then the signing key.
A wrong key shows up as a 401 in the provider's log, not as a silent failure.
