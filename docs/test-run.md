# Doing a test run first

Worth an hour before a real mint. You end up having watched a token go from
hidden to revealed, which is the only way to be sure the whole chain of pieces
lines up.

Nothing here needs a hosting account. The server runs on your machine and is
exposed through a Cloudflare quick tunnel, which needs no login.

## What you need

A test drop you control. Either a small drop on a testnet, or a small cheap drop
on mainnet that you do not mind existing. What matters is that you own the
contract, so you can call `setBaseURI`, and that it has not minted out.

You also want the drop left unrevealed in OpenSea Studio, which is the normal
state before a reveal: `baseURI` set to a single placeholder URI with no trailing
slash.

## 1. Point the config at your test drop

```ts
// drop.config.ts
chain: "base_sepolia",
contract: "0xYourTestDrop",
tokenIdStart: 1,
maxSupply: 10,
```

`maxSupply` has to match the contract. Preflight will tell you if it does not.

## 2. Make some metadata

Real metadata if you have it. Otherwise the four sample files in
`metadata/example/` are enough to see the mechanism work:

```bash
npm run build:manifest -- --dir metadata/example
```

For a ten token test, copy those four into `metadata/` and duplicate them up to
ten files so every token has something to reveal.

## 3. Check against the live contract

```bash
export RPC_URL="https://base-sepolia.g.alchemy.com/v2/YOUR_KEY"
npm run preflight
```

Read what it prints. It tells you the current `totalSupply`, whether
`maxSupply` matches your config, which wallet owns the contract, and what
`baseURI` is set to right now.

## 4. Run the server and expose it

```bash
npm run dev
```

In a second terminal:

```bash
npx cloudflared tunnel --url http://localhost:8787
```

Copy the `https://....trycloudflare.com` URL it prints, then check the server
through it:

```bash
npm run preflight -- --url https://....trycloudflare.com
```

You want the two lines about cache headers and the two about reveal state to all
say ok. If a token that is minted onchain reads as unminted, or the other way
round, stop here and fix that before touching the contract.

## 5. Point the contract at the tunnel

From the wallet that owns the drop, with the trailing slash:

```bash
cast send 0xYourTestDrop "setBaseURI(string)" "https://....trycloudflare.com/" \
  --rpc-url $RPC_URL --private-key $YOUR_KEY
```

Confirm the contract agrees:

```bash
cast call 0xYourTestDrop "tokenURI(uint256)(string)" 1 --rpc-url $RPC_URL
```

That should print your tunnel URL with `1` on the end. If it prints the URL
without the `1`, the trailing slash is missing.

## 6. Mint, and watch

Keep an eye on the terminal running `npm run dev`. Before the mint:

```
  GET /5  200  unminted   1ms
```

Mint token 5 through Studio, or directly. Within `ttlSeconds` (10 by default):

```
  GET /5  200  minted     94ms
```

Then look at it the way a buyer would:

```bash
curl -s https://....trycloudflare.com/5 | head -20
curl -sI https://....trycloudflare.com/5 | grep -i cache-control
curl -sI https://....trycloudflare.com/6 | grep -i -e cache-control -e x-reveal-state
```

Token 5 should be your real metadata with a long `immutable` cache lifetime.
Token 6, still unminted, should be the placeholder with `max-age=0`.

## 7. Check what OpenSea shows

OpenSea reads `tokenURI` when it indexes the mint, so a freshly minted token
normally arrives already revealed. If you turned the server on partway through a
mint, tokens minted before that were indexed against the placeholder and need a
nudge:

```bash
OPENSEA_API_KEY=... npm run refresh -- --from 1 --to 10
```

Refreshes are queued rather than instant.

## 8. Optional, try the webhook

This is the difference between a reveal in ten seconds and a reveal in one. You
can fake a delivery to see the path work, without setting up a provider:

```bash
# restart the server with a secret set
WEBHOOK_SECRET=test-secret npm run dev
```

```bash
curl -X POST https://....trycloudflare.com/webhook/mint \
  -H "Authorization: Bearer test-secret" \
  -d '{"tokenIds": [7]}'

curl -sI https://....trycloudflare.com/7 | grep -i x-reveal-state
```

Token 7 reads as `minted` immediately, without the server asking the chain
anything. For a real Alchemy webhook, see [webhooks.md](webhooks.md).

Remember that a webhook can only bring a reveal forward, so a test delivery for a
token that has not really minted stays revealed until you restart the server.
Only do that on a test drop.

## 9. Put the test drop back

If it is a mainnet test drop you want to keep tidy, set `baseURI` back to
whatever it was, or to the real IPFS directory:

```bash
cast send 0xYourTestDrop "setBaseURI(string)" "ipfs://<cid>/" \
  --rpc-url $RPC_URL --private-key $YOUR_KEY
```

## Things that will trip you up

The trailing slash. Without it, every token returns the same URI and nothing
reveals. Preflight warns about it.

A tunnel URL that changed. Quick tunnels get a new hostname every time you start
one, and the contract is still pointing at the old one. Either re-run
`setBaseURI` or use a real deployment.

A metadata set smaller than the drop. Tokens past the end of your set mint and
then sit on the placeholder forever, reported as `metadata-missing` in the
`x-reveal-state` header and as a problem at `/status`.

A cold start. The first request after the server starts pays for one RPC round
trip, which can be a second or two. Every request after that is served from
memory until the TTL expires.
