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

For plenty of drops that is the right answer, and this repository is not for
them. The reason most drops delay a reveal is sniping: a public metadata
directory tells anyone that token 412 is the good piece, and SeaDrop hands out
IDs in order, so watching the supply climb is enough to mint at exactly the right
moment. Delayed reveal removes that, at the cost of the thing everyone wants,
which is seeing what they got.

This server gives you both. Minters see their token seconds after minting, and
there is no published mapping to time a transaction against.

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

It hides which token ID gets which artwork, for tokens that have not minted. Not
the artwork itself, so your images can sit on public IPFS as normal. Which token
gets which piece is fixed before the mint opens, by token ID alone, so a reorg
can reveal a token a few seconds early but never hand someone the wrong one, and
the server fails closed, so failures make reveals late rather than early.
[docs/security.md](docs/security.md) has the full picture: what it deliberately
does not hide, and how holders can verify you did not reorder the good pieces.

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
npm run deploy         # Cloudflare. docs/deploy.md covers the other options
```

Point the contract at it, from the wallet that owns the drop. The trailing slash
is required: without it SeaDrop returns that exact URI for every token, which is
how a pre-reveal drop works.

```bash
cast send <your contract> "setBaseURI(string)" "https://your-worker.workers.dev/" \
  --rpc-url $RPC_URL --private-key $YOUR_KEY
```

Finally, confirm the deployed server and the chain agree. This checks the things
that are easy to get wrong: that a minted token really is revealed, that an
unminted one really is not, and that the cache headers will not strand a
placeholder.

```bash
npm run preflight -- --url https://your-worker.workers.dev
```

## How fast is the reveal

Within `mintState.ttlSeconds` of the mint, 10 seconds by default. The server
makes at most one chain read per window however much traffic it gets, so a busy
mint costs about six RPC calls a minute.

Point a webhook at it for about a second instead. Polling keeps running
underneath, so a missed delivery costs nothing. See
[docs/webhooks.md](docs/webhooks.md).

## After your drop mints out

Export the final metadata, pin it, and hand the collection back to IPFS. The
export applies the shuffle, if you used one, so the pinned files match what the
server has been serving. What to check before switching the server off is in
[docs/after-mint-out.md](docs/after-mint-out.md).

```bash
npm run export
ipfs add -r --cid-version 1 out
cast send <your contract> "setBaseURI(string)" "ipfs://<cid>/"
```

## What it costs

Nothing, for most drops. No database and no storage bill: your metadata is
compiled into the deployment, and the only outbound traffic is one chain read
every few seconds. Cloudflare's free plan covers 100,000 requests a day and
Vercel's hobby plan is comparable.

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

Every token response carries an `x-reveal-state` header saying what the server
decided and why: `minted`, `unminted`, `reveal-all`, `reveal-none`,
`rpc-unavailable`, `throttled`, `metadata-missing`, or `error`.

## Documentation

- [How it works](docs/how-it-works.md), the mechanism and the cache rules
- [Deploying](docs/deploy.md), including a free option with no account anywhere
- [Doing a test run first](docs/test-run.md)
- [Webhooks](docs/webhooks.md)
- [Security and what is actually hidden](docs/security.md)
- [Verifying a shuffle](docs/verify-a-shuffle.md), for you and your holders
- [After mint out](docs/after-mint-out.md)
- [Large drops](docs/large-drops.md), over a few thousand tokens
- [Troubleshooting](docs/troubleshooting.md)

## Working on this

CI runs one command, and it is the same one you run here, so the two cannot
disagree about what passing means:

```bash
npm run ci
```

Lint and format, typecheck, the tests, then two guards: `check:worker`, that
nothing under `src/` picked up an API Cloudflare Workers cannot provide, and
`check:privacy`, that no unrevealed metadata is staged. CI runs it on the minimum
supported Node rather than the newest, so a change that breaks the version this
README tells you to install cannot pass.

[AGENTS.md](AGENTS.md) has the rest: architecture, the invariants, and what to
check before a PR.

## Support

A reference implementation, shared so creators and partners can run instant
reveal themselves. It is not a hosted OpenSea product, and OpenSea does not
operate the server you deploy. Issues and pull requests are welcome, with no
promised response time.

If you want instant reveal inside OpenSea Studio rather than self-hosted, say so
in an issue. Interest is useful information.

## License

MIT. See [LICENSE](LICENSE).
