# Webhooks

> Optional. Turns a ten second reveal into a one second one by having your node
> provider push mints instead of the server polling for them. Also covers the
> shared store serverless hosts need, and what it really buys you.

Polling gets a reveal out within `mintState.ttlSeconds`, 10 seconds by default. A
webhook gets it out in about one, by having your node provider tell the server
about a mint instead of the server asking.

Polling keeps running underneath either way, so a webhook that is misconfigured,
rate limited, or silently dropped costs nothing. Treat it as an optimisation, not
a dependency.

Both routes return 404 until you set their secret, so an unconfigured deployment
has no unauthenticated write surface.

## What a webhook can and cannot do

It can raise the high water mark, which reveals tokens. It cannot lower it, hide
a token, or change which artwork a token maps to, so a duplicate, out of order,
or replayed delivery is harmless.

That asymmetry is the risk, too: a leaked webhook secret buys an attacker an
early reveal and nothing else. If you would rather not carry even that, leave
webhooks off. Polling is at most ten seconds behind.

One caveat in `sequential` mode. It treats a token ID as a cursor, so a delivery
for token 900 reveals 1 through 900. Correct for SeaDrop, which mints in order,
and wrong for a contract that does not: an owner-minted reserve at the top of the
range would reveal the whole drop. Use `ownerOf` mode there, which records the
exact IDs a delivery names and nothing else.

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

Custom Webhooks and Address Activity work as well, though NFT Activity is the
closer fit. The server reads token IDs out of whichever shape arrives,
`erc721TokenId` fields on activity entries and raw `Transfer` logs from a GraphQL
webhook, and ignores anything not for your contract.

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

`revealedThrough` is a cursor for an indexer that tracks supply rather than
individual mints, and it only means anything in `sequential` mode, since that is
the only mode that reads a high water mark. In `ownerOf` mode the server answers
400 rather than revealing token 512 alone and quietly dropping the "through"
part; send the ids individually there.

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

`tokenIdsApplied` counts the IDs inside your drop's range. A 0 means they were
all outside `tokenIdStart` to `tokenIdStart + maxSupply - 1`, so `tokenIdStart`
is probably wrong.

## Serverless hosts need one more step

Cloudflare and Vercel run many independent copies of your code, and a delivery
arrives at one. That copy reveals the token straight away; the others find out on
their next poll unless you give them somewhere shared to look.

On Cloudflare, bind a KV namespace:

```bash
npx wrangler kv namespace create REVEAL_STATE
```

Put the id in the `kv_namespaces` block of `wrangler.toml` and redeploy.
`/status` will show `revealStore: Cloudflare KV, shared across instances`.

A single Node process needs none of this, since there is only one copy.

### What KV does and does not buy you

The obvious reading is wrong, so it is worth being exact. KV does not hand the
write to every instance at once. Reads come from a cache at the reading colo
whose TTL cannot go below 60 seconds, so an instance that read the key just
before your webhook landed can serve the old value for up to a minute.

The poller, not KV, is therefore what bounds how far behind an instance can be:
at the default `ttlSeconds` of 10, nobody is more than about ten seconds late. KV
takes the common case below that and can never make it worse, because the mark
only rises. Binding it is worth doing. Expecting it to be instant is not, and
that would need a single coordination point rather than a cache, which on
Cloudflare means a Durable Object this repository deliberately does not carry.

KV allows about one write per second per key, and a fast mint raises the mark
faster than that, so writes are coalesced: only the newest value lands, and it
supersedes the ones it skipped. If KV is unreachable the delivery still succeeds,
because the reveal comes from the instance's own mark, and the value is kept for
the next write rather than dropped. `/status` reports the failure under
`mintState.lastError`.

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
