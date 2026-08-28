# Doing a test run first

> An hour with a throwaway drop, start to finish, on your own machine through a
> tunnel. Watching one token go from hidden to revealed is the only way to be
> sure every piece lines up.

## What you need

A test drop you control, on a testnet or a cheap mainnet one you do not mind
existing. What matters is that you own the contract, so you can call
`setBaseURI`, and that it has not minted out. Leave it unrevealed in OpenSea
Studio, the normal pre-reveal state.

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

Real metadata if you have it, otherwise copy the four samples in
`metadata/example/` into `metadata/` and duplicate them up to ten files, so every
token has something to reveal.

```bash
npm run build:manifest
```

## 3. Check against the live contract

```bash
export RPC_URL="https://base-sepolia.g.alchemy.com/v2/YOUR_KEY"
npm run preflight
```

It prints how many tokens are minted, whether `maxSupply` matches your config,
which wallet owns the contract, the current `baseURI`, and whether burns can hide
a token on this contract.

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

The two cache header lines and the two reveal state lines should all say ok. If a
minted token reads as unminted, or the reverse, fix that before touching the
contract.

## 5. Point the contract at the tunnel

From the wallet that owns the drop, with the trailing slash:

```bash
cast send 0xYourTestDrop "setBaseURI(string)" "https://....trycloudflare.com/" \
  --rpc-url $RPC_URL --private-key $YOUR_KEY
cast call 0xYourTestDrop "tokenURI(uint256)(string)" 1 --rpc-url $RPC_URL
```

The second command should print your tunnel URL with `1` on the end. Without the
`1`, the trailing slash is missing.

## 6. Mint, and watch

Keep an eye on the terminal running `npm run dev`:

```
  GET /5  200  unminted   1ms
```

Mint token 5 through Studio, or directly. Within `ttlSeconds`, 10 by default:

```
  GET /5  200  minted     94ms
```

Then look at it the way a buyer would. Token 5 should be your real metadata with
a long `immutable` cache lifetime; token 6, still unminted, the placeholder with
`max-age=0`.

```bash
curl -s https://....trycloudflare.com/5 | head -20
curl -sI https://....trycloudflare.com/5 | grep -i cache-control
curl -sI https://....trycloudflare.com/6 | grep -i -e cache-control -e x-reveal-state
```

## 7. Check what OpenSea shows

A freshly minted token arrives already revealed, because OpenSea reads `tokenURI`
when it indexes the mint. Tokens minted before you turned the server on were
indexed against the placeholder and need a nudge, which is queued rather than
instant:

```bash
OPENSEA_API_KEY=... npm run refresh -- --from 1 --to 10
```

## 8. Optional, try the webhook

The difference between a reveal in ten seconds and one in a second. Fake a
delivery to see the path work, without setting up a provider:

```bash
WEBHOOK_SECRET=test-secret npm run dev
```

```bash
curl -X POST https://....trycloudflare.com/webhook/mint \
  -H "Authorization: Bearer test-secret" \
  -d '{"tokenIds": [7]}'

curl -sI https://....trycloudflare.com/7 | grep -i x-reveal-state
```

Token 7 reads as `minted` immediately, without the server asking the chain. A
webhook can only bring a reveal forward, so a test delivery for a token that has
not really minted stays revealed until you restart the server. Only do this on a
test drop. For a real Alchemy webhook see [webhooks.md](webhooks.md).

## 9. Put the test drop back

Set `baseURI` back to whatever it was, or to the real IPFS directory:

```bash
cast send 0xYourTestDrop "setBaseURI(string)" "ipfs://<cid>/" \
  --rpc-url $RPC_URL --private-key $YOUR_KEY
```

## Things that will trip you up

The trailing slash. Without it every token returns the same URI and nothing
reveals. Preflight warns about it.

A tunnel URL that changed. Quick tunnels get a new hostname each time, and the
contract still points at the old one. Re-run `setBaseURI` or use a real
deployment.

A metadata set smaller than the drop. Tokens past the end of your set mint and
then sit on the placeholder forever, reported as `metadata-missing`.

A cold start. The first request after the server starts pays one RPC round trip,
a second or two. Everything after that comes from memory until the TTL expires.
