# Instant reveal drop metadata

A metadata server you host yourself. Each NFT becomes visible the moment its
mint lands onchain, while everything still unminted stays hidden.

No contract changes and no new tooling in your mint flow. You point your drop
contract's `baseURI` at this server instead of at an IPFS directory, and move it
back to IPFS once the mint is over.

Runs on Cloudflare Workers, Vercel, or any Node process. No database. For a test
run you can serve it from your laptop through a tunnel without signing up for
anything.

## Why not just publish the metadata up front

For plenty of drops that is the right answer. Set `baseURI` to your IPFS
directory at launch and everything is revealed from the first mint.

The reason most drops do not is sniping. A public metadata directory tells
anyone that token 412 is the good piece, and SeaDrop hands out IDs in order, so
watching `totalSupply` climb is enough to mint at exactly the right moment.
Delayed reveal removes that, at the cost of the thing everyone wants: seeing
what they got.

This server gives you both. Minters see their token seconds after minting, and
there is no published mapping to time a transaction against.

## How it works

```
   minter                     your contract                this server
     |                             |                             |
     |--- mint ------------------->|                             |
     |                             |                             |
  marketplace                      |                             |
     |--- tokenURI(41) ----------->|                             |
     |<-- https://you.dev/41 ------|                             |
     |                             |                             |
     |--------------------- GET /41 -----------------------------|
     |                                       is 41 minted? --------> chain
     |<-------------------- the real metadata -------------------|
     |                                                           |
     |--------------------- GET /42 -----------------------------|
     |<-------------------- placeholder, not minted yet ---------|
```

The contract needs no changes. A SeaDrop `baseURI` ending in a slash means
revealed, and `tokenURI(41)` returns `baseURI + "41"`. An https base URI works
exactly like an `ipfs://` one.

Which artwork a token gets is decided before the mint opens, by token ID alone.
A reorg can therefore reveal a token a few seconds early, but can never hand
someone the wrong piece.

The server fails closed. If it cannot reach the chain, or its metadata, it
serves the placeholder. Failures make reveals late, never early.

A revealed token is cached forever, an unrevealed one is never cached at all.
The second half matters more than it looks: a CDN that holds one "unrevealed"
response keeps serving a placeholder for a token that has since minted. The
headers are set in one place, and tested.

## What this hides, and what it does not

It hides which token ID gets which artwork, for tokens that have not minted.

It does not hide the artwork itself. Your images can sit on public IPFS as
normal, because an image alone does not say which token ID it belongs to.

It does not hide the rarity distribution. Anyone can count the traits of what
has minted and work out what is left, which is true of any reveal scheme.

It cannot un-reveal something. Once a token mints its metadata is public, and
anyone can archive it.

To let holders check that you did not quietly reorder the good pieces, turn on
the optional shuffle: publish a hash of your metadata set and a commitment to a
secret seed before minting, then publish the seed afterwards. See
[docs/security.md](docs/security.md).

## Quick start

Node 22.18 or newer, and a drop that has not minted out.

```bash
git clone https://github.com/ProjectOpenSea/instant-reveal-drop-metadata
cd instant-reveal-drop-metadata
npm install
```

Put one JSON file per token in `metadata/`, named `1.json`, `2.json`, and so on.
Then compile them into the server:

```bash
npm run build:manifest
```

Edit `drop.config.ts`, the only file you need to touch. At minimum set `chain`,
`contract`, `maxSupply`, and a `placeholder` image. Then check it against the
live contract, run it, and deploy:

```bash
npm run preflight
npm run dev            # then open http://localhost:8787/1 and /status
npx wrangler deploy    # docs/deploy.md covers the other options
```

Point the contract at it, from the wallet that owns the drop:

```bash
cast send <your contract> "setBaseURI(string)" "https://your-worker.workers.dev/" \
  --rpc-url $RPC_URL --private-key $YOUR_KEY
```

The trailing slash is required. Without it SeaDrop returns that exact URI for
every token, which is how a pre-reveal drop works.

Finally, confirm the deployed server and the chain agree:

```bash
npm run preflight -- --url https://your-worker.workers.dev
```

That checks the things that are easy to get wrong: that a minted token really is
revealed, that an unminted one really is not, and that the cache headers will
not strand a placeholder.

## How fast is the reveal

A reveal lands within `mintState.ttlSeconds` of the mint, 10 seconds by default.
The server reads `totalSupply()` at most once per window however much traffic it
gets, so a busy mint costs about six RPC calls a minute.

For about a second instead, point a webhook at it. Alchemy is supported directly
with signature verification, and there is a provider agnostic route for anything
else. Polling keeps running underneath, so a missed delivery costs nothing.

```bash
curl -X POST https://your-worker.workers.dev/webhook/mint \
  -H "Authorization: Bearer $WEBHOOK_SECRET" \
  -d '{"tokenIds": [41]}'
```

See [docs/webhooks.md](docs/webhooks.md).

## After your drop mints out

Export the final metadata, pin it, and hand the collection back to IPFS:

```bash
npm run export
ipfs add -r --cid-version 1 out
cast send <your contract> "setBaseURI(string)" "ipfs://<cid>/"
```

The export applies the shuffle, if you used one, so the pinned files match what
the server has been serving. What to check before switching the server off is in
[docs/after-mint-out.md](docs/after-mint-out.md).

## What it costs

Nothing, for most drops. No database and no storage bill: your metadata is
compiled into the deployment, and the only outbound traffic is a `totalSupply`
read every few seconds. Cloudflare's free plan covers 100,000 requests a day,
more than a normal drop generates, and Vercel's hobby plan is comparable. A free
Alchemy or similar key is plenty for a real mint.

## Endpoints

| Path | What it does |
| --- | --- |
| `GET /{tokenId}` | The metadata, real or placeholder. This is what `baseURI` points at. |
| `GET /status` | Whether the setup is working, how far the mint has got, and what is wrong if anything is. Safe to share, never includes a secret. |
| `GET /provenance` | The manifest hash, the seed commitment, and the seed once you publish it. |
| `GET /health` | Returns `ok`. |
| `GET /contract.json` | Collection level metadata, if you configured any. |
| `POST /webhook/alchemy` | Alchemy Notify deliveries. Off until you set a signing key. |
| `POST /webhook/mint` | Any other provider, or your own script. Off until you set a secret. |

Every token response carries an `x-reveal-state` header, which says what the
server decided and why: `minted`, `unminted`, `reveal-all`, `reveal-none`,
`rpc-unavailable`, `metadata-missing`, or `error`.

## Documentation

- [How it works](docs/how-it-works.md), in more detail than the diagram above
- [Deploying](docs/deploy.md), including a free option with no account anywhere
- [Doing a test run first](docs/test-run.md)
- [Webhooks](docs/webhooks.md)
- [Security and what is actually hidden](docs/security.md)
- [Verifying a shuffle](docs/verify-a-shuffle.md), for you and your holders
- [After mint out](docs/after-mint-out.md)
- [Large drops](docs/large-drops.md), over a few thousand tokens
- [Troubleshooting](docs/troubleshooting.md)

## Working on this

CI runs these on the Node version in `engines`, current LTS, and latest. They
all run locally too:

```bash
npm test              # 61 tests, no network
npm run typecheck
npm run lint          # biome, lint and format together (`lint:fix` to apply)
npm run check:worker  # the shared code still bundles for Cloudflare Workers
npm run check:privacy # no unrevealed metadata staged or committed
```

`check:worker` matters because every test runs on Node. It is the only thing
that notices when something under `src/` picks up an API Workers cannot provide,
which would pass tests and typecheck and then fail on the recommended deploy
target.

## Support

A reference implementation, shared so creators and partners can run instant
reveal themselves. It is not a hosted OpenSea product, and OpenSea does not
operate the server you deploy. Issues and pull requests are welcome, with no
promised response time.

If you want instant reveal inside OpenSea Studio rather than self-hosted, say so
in an issue. Interest is useful information.

## License

MIT. See [LICENSE](LICENSE).
