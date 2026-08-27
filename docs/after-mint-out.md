# After your drop mints out

You do not have to keep this running forever. Once every token is minted there is
nothing left to hide, so the sensible end state is the normal one: a pinned IPFS
directory with the contract pointing at it.

## Option 1, hand the collection back to IPFS

The recommended path. Nothing depends on your server afterwards.

```bash
npm run export
```

That writes one file per token to `out/`, named after the token ID with no
extension, which is what `tokenURI` expects. The shuffle, if you used one, is
already applied, so the files match what the server has been serving.

Pin the directory:

```bash
ipfs add -r --cid-version 1 out
```

Or upload it through Pinata, web3.storage, Filebase, or whatever you already use.

Check a token resolves through a gateway before changing anything onchain:

```bash
curl -s https://ipfs.io/ipfs/<cid>/1 | head
```

Compare it to what your server serves for the same token. They should be
identical:

```bash
diff <(curl -s https://ipfs.io/ipfs/<cid>/1) <(curl -s https://your-server/1)
```

Then point the contract at the CID, from the owner wallet, with the trailing
slash:

```bash
cast send <contract> "setBaseURI(string)" "ipfs://<cid>/" \
  --rpc-url $RPC_URL --private-key $KEY
```

Ask OpenSea to re-read the tokens, since the URI changed:

```bash
OPENSEA_API_KEY=... npm run refresh
```

Leave the server up for a day or two while indexers catch up, then switch it off.

## Option 2, leave the server running

Fine too, and simpler. Set the reveal switch so nothing depends on chain reads:

```bash
npx wrangler secret put REVEAL_ALL   # value: true
```

Every token is then served immediately, and the server stops calling your RPC
endpoint entirely.

The trade is that your collection's metadata now depends on a server you
maintain, a domain you keep renewing, and an account in good standing. Collectors
prefer IPFS for that reason. If you go this way, use a domain you control rather
than a `*.workers.dev` or `*.vercel.app` hostname, so you can move hosts later
without touching the contract.

## Publishing the seed, if you used a shuffle

Do this once minting is finished, so holders can verify the mapping:

```bash
npx wrangler secret put PUBLISH_SEED   # value: true
```

`/provenance` then serves the seed alongside the commitment you published before
the mint, and anyone can recompute the mapping. See
[verify-a-shuffle.md](verify-a-shuffle.md), and post the seed wherever you
announced the drop rather than only at an endpoint.

If you pin to IPFS, `npm run export -- --include-seed` puts the seed in
`out/provenance.json` as well, making the record permanent. That file is public
and forever, so it is opt in.

## If the drop never mints out

Common enough, and nothing breaks. Unminted tokens keep returning the placeholder
indefinitely, which is the correct answer: they do not exist.

To make the remaining tokens look finished rather than pending after closing a
mint early, edit the placeholder in `drop.config.ts` and redeploy.

## What to check before switching the server off

Does `tokenURI` return the IPFS URI, for a few different token IDs.

Does a gateway serve each of those without a long delay on first fetch.

Does OpenSea show the artwork, on tokens sampled across the range rather than
only token 1.

Is anything else pointing at the server: a custom `contractURI`, your own site, a
Discord bot, an analytics job. Those are easy to forget and break quietly.
