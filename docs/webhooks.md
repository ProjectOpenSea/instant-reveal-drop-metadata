# Webhooks

Polling gets a reveal out within `mintState.ttlSeconds`, 10 seconds by default. A
webhook gets it out in about one, by having your node provider tell the server
about a mint instead of the server asking.

Polling keeps running underneath either way. A webhook that is misconfigured,
rate limited, or silently dropped costs you nothing: the poll behind it still
finds the mint. So treat this as an optimisation, not a dependency.

Both routes return 404 until you set their secret, so an unconfigured deployment
has no unauthenticated write surface at all.

## What a webhook can and cannot do

It can raise the high water mark, which reveals tokens.

It cannot lower it, cannot hide a token, and cannot change which artwork a token
maps to. A duplicate delivery, an out of order delivery, or a replay of an old one
is harmless.

That asymmetry is deliberate, and it is also the risk to understand: the only
thing a webhook secret buys an attacker is the ability to reveal your drop
earlier than you meant to. Nothing can be stolen, and no mapping can be changed.
If you would rather not carry that at all, leave webhooks off. Polling is at most
ten seconds behind.

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

Alchemy's Custom Webhooks work as well. The server reads token IDs out of
whichever shape arrives: `erc721TokenId` fields on activity entries, and raw
`Transfer` logs from a GraphQL webhook. Anything that is not for your contract is
ignored.

Address Activity webhooks also work, though NFT Activity is the closer fit.

### Verifying a delivery yourself

The signature is `HMAC-SHA256(signing key, raw request body)`, hex encoded, in the
`x-alchemy-signature` header. To reproduce it:

```bash
printf '%s' "$BODY" | openssl dgst -sha256 -hmac "$SIGNING_KEY" -hex
```

## Any other provider

`POST /webhook/mint` takes a bearer token you choose and a small JSON body. Use it
for QuickNode, Moralis, Helius, your own indexer, a GitHub Action, or a shell
loop.

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

`tokenIdsApplied` counts the IDs that were inside your drop's range. If it comes
back 0, the IDs were outside `tokenIdStart` to `tokenIdStart + maxSupply - 1`, and
you probably have `tokenIdStart` wrong.

## Serverless hosts need one more step

Cloudflare and Vercel run many independent copies of your code, and a delivery
arrives at exactly one of them. Without somewhere shared to write, the other
copies find out on their next poll, which throws away most of the speed you set
this up for.

On Cloudflare, bind a KV namespace:

```bash
npx wrangler kv namespace create REVEAL_STATE
```

Put the id in the `kv_namespaces` block of `wrangler.toml` and redeploy.
`/status` will show `revealStore: Cloudflare KV, shared across instances`.

A single Node process needs none of this, since there is only one copy.

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
the provider's own delivery log first, then that the URL has no typo, then that
the signing key matches. A wrong key shows up as a 401 in the provider's log
rather than as a silent failure.
