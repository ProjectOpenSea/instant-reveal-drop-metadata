# How it works

> The mechanism: what the contract does, how the server decides whether a token
> is minted, and which responses may be cached. This page owns those three
> topics, and the others link here rather than repeat them.

## The contract side

OpenSea Studio deploys ERC721A based SeaDrop contracts. Their `tokenURI` does
something specific that this whole approach depends on:

```solidity
function tokenURI(uint256 tokenId) public view override returns (string memory) {
    if (!_exists(tokenId)) revert URIQueryForNonexistentToken();
    string memory theBaseURI = _baseURI();
    if (bytes(theBaseURI).length == 0) return "";
    // No trailing slash means the drop is not revealed: every token returns
    // the same URI.
    if (bytes(theBaseURI)[bytes(theBaseURI).length - 1] != bytes("/")[0]) {
        return theBaseURI;
    }
    return string(abi.encodePacked(theBaseURI, _toString(tokenId)));
}
```

Three consequences:

A `baseURI` ending in a slash is what "revealed" means to the contract. It then
appends the decimal token ID with no file extension, so `tokenURI(41)` is
`https://you.example/41`. That is why this server serves `/41` and not
`/41.json`, though it accepts both. Leaving the slash off is the most common
mistake with this setup, and it is not a malfunction: it is exactly how a
pre-reveal drop is configured.

The contract does not care whether the base URI is `ipfs://` or `https://`.
Nothing changes onchain except the string.

An unminted token has no `tokenURI` at all, because the call reverts:

```bash
cast call <contract> "tokenURI(uint256)(string)" 999999 --rpc-url $RPC_URL
# Error: execution reverted, data: "0xa14c4b50"   URIQueryForNonexistentToken()
```

That last point is why the gating has to live in the server. The contract already
refuses to name a URI for an unminted token, but the server is plain HTTP anyone
can request directly, and a sniper would simply skip the contract and read it. So
the server checks for itself, every time.

## The reveal decision

For each request the server answers one question: does this token exist onchain?

### sequential, the default

SeaDrop mints IDs in order, so one number settles every token: with
`tokenIdStart: 1` and 240 minted, tokens 1 through 240 exist and 241 upward do
not. One chain read per TTL window answers every request in that window, so cost
does not grow with traffic.

Which read it makes matters more than it looks. `totalSupply()` on ERC721A is
minted minus burned, so one burn during the mint would park the highest minted
token on the placeholder until another mint replaced it, and permanently if the
drop never mints out. The server prefers `getMintStats(address)`, whose second
return value is ERC721A's `_totalMinted()`, which burns do not lower. It probes
for that once and falls back to `totalSupply()` on a contract without it.
`/status` reports which one under `mintState.supplyReader`, and
`npm run preflight` says so before you go live.

### ownerOf

Reads `ownerOf(tokenId)` per token, which reverts for an unminted one. Use it if
your contract can mint IDs out of order, for example a custom mint function or an
airdrop of high IDs. Positive answers are cached permanently, because a minted
token never unmints.

One call per token also means one inbound request can become one RPC call, so
anything that walks your range once, a scraper or a marketplace reindexing the
collection, spends your RPC budget at whatever rate it likes. At most 64 of those
reads run at a time; past that the server answers without asking the chain, which
withholds the token and sets `x-reveal-state: throttled`, because a late reveal
is the right side to be wrong on. `/status` counts them under
`mintState.throttledChecks`, separately from errors, since declining a read is a
decision rather than a fault. `sequential` mode never reaches this.

### What both modes guarantee

A high water mark that only rises, so an RPC node answering from an older block
cannot un-reveal a token a buyer has seen.

A failed read serves the placeholder and sets `x-reveal-state: rpc-unavailable`
rather than `unminted`, so an outage is visible instead of looking like a drop
nobody is buying. The failing endpoint is then left alone for a couple of seconds
rather than retried on every request.

## The mapping

```
position = tokenId - tokenIdStart
index    = shuffle ? permutation[position] : position
```

`index` is the position in your metadata set, zero based. With the shuffle off,
token 1 gets your first file. With it on, a secret seed decides, and the mapping
is still fixed before the mint opens.

Nothing here depends on mint order, buyer, or time. Given a token ID, the answer
was determined before anyone minted anything, which is what makes the scheme safe
against reorgs and verifiable afterwards. [security.md](security.md) covers why
you might want the shuffle, [verify-a-shuffle.md](verify-a-shuffle.md) how to
check one.

## The cache rules

| Response | `Cache-Control` |
| --- | --- |
| Revealed token | `public, max-age=31536000, s-maxage=31536000, immutable` |
| Unrevealed token, throttled and `rpc-unavailable` included | `public, max-age=0, s-maxage=0, must-revalidate` |
| Minted but no metadata | `no-store` |
| Anything that errored | `no-store` |
| `/status`, `/health`, and the index page | `no-store` |

A revealed token never changes, so it is safe to cache forever. An unrevealed one
stops being true the moment the token mints, so nothing may cache it. Getting
that wrong is the failure people notice: the token mints, the buyer refreshes,
and a CDN keeps handing them the placeholder.

`npm run preflight -- --url https://your-server` checks both.

## Failing closed

Every failure path ends the same way: serve the placeholder, refuse to let
anything cache it, name the reason in `x-reveal-state`. An unreachable chain, a
502 from a metadata source, unparseable JSON in a bucket, a missing shuffle seed.
None of them produce a 500, which would leave a marketplace recording a broken
token, and none produce real metadata for a token that has not minted.

An outage therefore costs you a late reveal, which is recoverable, instead of an
early one, which is not.

## Where the metadata lives

Three options, set with `metadata.source`. `bundled` compiles your files into the
deployment and is right for most drops, `r2` reads a private Cloudflare R2
bucket, `http` reads a private base URL you control. Sizes, trade-offs and setup
are in [large-drops.md](large-drops.md).

## What runs where

`src/handler.ts` is the whole HTTP surface, and takes a `Request` and a runtime.
The three adapters build that runtime from their platform's environment and call
it. Nothing else is platform specific, which is why the tests drive the real
handler with a fake chain and no network.

```
adapters/cloudflare.ts   ->  src/handler.ts  ->  src/mint-state.ts  ->  chain
api/index.ts (Vercel)                        ->  src/token-metadata.ts
adapters/node.ts                             ->  src/sources/*
```
