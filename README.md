# Instant reveal drop metadata

A small metadata server you host yourself. Each NFT in your drop becomes visible
the moment its mint lands onchain, while everything still unminted stays hidden.

No contract changes, no new tooling in your mint flow. You point your drop
contract's `baseURI` at this server instead of at an IPFS directory, and you can
move it back to IPFS once the mint is over.

It runs on Cloudflare Workers, Vercel, or any Node process, and it needs no
database. For a test run you can serve it from your laptop through a tunnel
without signing up for anything.

## Why not just publish the metadata up front

You can, and for plenty of drops that is the right answer. Set `baseURI` to your
IPFS directory at launch and everything is revealed from the first mint.

The reason most drops do not is sniping. If the full metadata directory is
public, anyone can read it, work out that token 412 is the one good piece, watch
`totalSupply` climb, and mint at exactly the right moment. SeaDrop hands out
token IDs in order, so a minter cannot pick their token ID, which means the whole
attack comes down to knowing the mapping and timing the transaction.

Delayed reveal removes that, at the cost of the thing everyone actually wants:
seeing what they got.

This server gives you both. Minters see their token seconds after minting, and
nobody can see a token that has not been minted yet, so there is no mapping to
time your transaction against.

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

Four things are worth knowing about that picture.

The contract does not need to understand any of this. A SeaDrop `baseURI` that
ends in a slash is treated as revealed, and `tokenURI(41)` returns
`baseURI + "41"`. An https base URI works exactly like an `ipfs://` one.

Which artwork a token gets is decided before the mint opens, by token ID alone.
It never depends on who minted it or when. That is why a chain reorg cannot hand
someone the wrong piece: the worst a reorg can do is reveal one token a few
seconds early.

The server fails closed. If it cannot reach the chain, it serves the placeholder.
An outage makes reveals late, never early.

A revealed token is cached forever, an unrevealed one is never cached at all.
That second half matters more than it looks: a CDN that holds on to one
"unrevealed" response will keep serving a placeholder for a token that has since
minted. The headers are set in one place, and there are tests on them.

## What this hides, and what it does not

It hides which token ID gets which artwork, for tokens that have not minted.

It does not hide the artwork itself. Your images can sit on public IPFS as
normal, because an image on its own does not say which token ID it belongs to.

It does not hide the rarity distribution. Anyone can count the traits of what has
already minted and work out what is left, which is true of any reveal scheme.

It cannot un-reveal something. Once a token has minted, its metadata is public,
and anyone can archive it.

If you want holders to be able to check that you did not quietly reorder the good
pieces, turn on the optional shuffle. You publish a hash of your metadata set and
a commitment to a secret seed before minting, then publish the seed afterwards.
Anyone can recompute the mapping and confirm it matches what was served all
along. See [docs/security.md](docs/security.md).

## Quick start

You need Node 22 or newer, and a drop that has not minted out yet.

```bash
git clone https://github.com/ProjectOpenSea/instant-reveal-drop-metadata
cd instant-reveal-drop-metadata
npm install
```

Put your metadata files in `metadata/`, one JSON file per token, named `1.json`,
`2.json`, and so on. Then:

```bash
npm run build:manifest
```

Edit `drop.config.ts`, which is the only file you need to touch. At minimum set
`chain`, `contract`, `maxSupply`, and a `placeholder` image. Then check your
setup against the live contract:

```bash
npm run preflight
```

Run it locally and look at a token:

```bash
npm run dev
open http://localhost:8787/1
open http://localhost:8787/status
```

Deploy it ([docs/deploy.md](docs/deploy.md) covers the options):

```bash
npx wrangler deploy
```

Then point your contract at it, from the wallet that owns the drop:

```bash
cast send <your contract> "setBaseURI(string)" "https://your-worker.workers.dev/" \
  --rpc-url $RPC_URL --private-key $YOUR_KEY
```

The trailing slash is required. Without it, SeaDrop returns that exact URI for
every token, which is how a pre-reveal drop works.

Finally, confirm the deployed server agrees with the chain:

```bash
npm run preflight -- --url https://your-worker.workers.dev
```

That last command checks the things that are easy to get wrong: that a minted
token really is revealed, that an unminted one really is not, and that the cache
headers will not strand a placeholder.

## How fast is the reveal

Out of the box, a reveal lands within `mintState.ttlSeconds` of the mint, which
defaults to 10 seconds. The server reads `totalSupply()` at most once per window,
however much traffic it is getting, so a busy mint costs about six RPC calls a
minute.

If you want it faster, point a webhook at the server and reveals land in about a
second. Alchemy is supported directly, with signature verification, and there is
a provider agnostic route for anything else. Polling keeps running underneath, so
a webhook that misses a delivery costs you nothing.

```bash
curl -X POST https://your-worker.workers.dev/webhook/mint \
  -H "Authorization: Bearer $WEBHOOK_SECRET" \
  -d '{"tokenIds": [41]}'
```

See [docs/webhooks.md](docs/webhooks.md).

## After your drop mints out

You do not have to keep this running forever. Export the final metadata, pin it,
and hand the collection back to IPFS:

```bash
npm run export
ipfs add -r --cid-version 1 out
cast send <your contract> "setBaseURI(string)" "ipfs://<cid>/"
```

The export applies the shuffle, if you used one, so the pinned files match
exactly what the server has been serving. Details, including what to check before
you switch the server off, are in
[docs/after-mint-out.md](docs/after-mint-out.md).

## What it costs

Nothing, for most drops. There is no database and no storage bill: your metadata
is compiled into the deployment, and the only outbound traffic is a `totalSupply`
read every few seconds.

Cloudflare's free plan covers 100,000 requests a day, which is more than a normal
drop generates. Vercel's hobby plan is comparable. A public RPC endpoint will do
for a test, and a free Alchemy or similar key is plenty for a real mint.

## Endpoints

| Path | What it does |
| --- | --- |
| `GET /{tokenId}` | The metadata, real or placeholder. This is what `baseURI` points at. |
| `GET /status` | Whether the setup is working, how far the mint has got, and what is wrong if anything is. Safe to share, it never includes a secret. |
| `GET /provenance` | The manifest hash, the seed commitment, and the seed once you publish it. |
| `GET /health` | Returns `ok`. |
| `GET /contract.json` | Collection level metadata, if you configured any. |
| `POST /webhook/alchemy` | Alchemy Notify deliveries. Off until you set a signing key. |
| `POST /webhook/mint` | Any other provider, or your own script. Off until you set a secret. |

Every token response carries an `x-reveal-state` header (`minted`, `unminted`,
`reveal-all`, `rpc-unavailable`, `metadata-missing`), which makes it obvious what
the server decided and why.

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

## Support

This is a reference implementation, shared so creators and partners can run
instant reveal themselves. It is not a hosted OpenSea product, and OpenSea does
not operate the server you deploy. Issues and pull requests are welcome, and no
response time is promised.

If you are looking at this because you want instant reveal inside OpenSea Studio
rather than self-hosted, say so in an issue. Interest is useful information.

## License

MIT. See [LICENSE](LICENSE).
