# How it works

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
`/41.json`, though it accepts both.

The contract does not care whether the base URI is `ipfs://` or `https://`. There
is nothing to change onchain other than the string.

An unminted token has no `tokenURI` at all, because the call reverts. You can
check this yourself:

```bash
cast call <contract> "tokenURI(uint256)(string)" 999999 --rpc-url $RPC_URL
# Error: execution reverted, data: "0xa14c4b50"   URIQueryForNonexistentToken()
```

That last point is worth dwelling on, because it explains why the gating has to
live in the server. The contract already refuses to name a URI for an unminted
token, but your server is plain HTTP that anyone can request directly. If it
answered `GET /412` with real metadata, a sniper would skip the contract entirely
and read the server. So the server checks for itself, every time.

## The reveal decision

For each request the server answers one question: does this token exist onchain?

`mintState.mode: "sequential"` is the default and reads `totalSupply()`. SeaDrop
mints IDs in order, so one number settles every token: with `tokenIdStart: 1` and
a supply of 240, tokens 1 through 240 are minted and 241 upward are not. One RPC
call per TTL window answers every request in that window, so the cost does not
grow with traffic.

`mintState.mode: "ownerOf"` reads `ownerOf(tokenId)` per token, which reverts for
an unminted one. Use it if your contract can mint IDs out of order, for example a
custom mint function or an airdrop of high IDs. It costs one call per token, and
positive answers are cached permanently because a minted token never unmints.

Both modes keep a high water mark that only ever rises. A burn lowers
`totalSupply`, and RPC providers behind a load balancer sometimes answer from an
older block, so without that rule a token could flip back to unrevealed after
being revealed.

## The mapping

```
position = tokenId - tokenIdStart
index    = shuffle ? permutation[position] : position
```

`index` is the position in your metadata set, zero based. With the shuffle off,
token 1 gets your first file. With it on, a secret seed decides, and the mapping
is still fixed before the mint opens.

Nothing about this depends on mint order, buyer, or time. Given a token ID, the
answer was determined before anyone minted anything, which is what makes the
scheme safe against reorgs and easy to verify afterwards.

## The cache rules

| Response | `Cache-Control` |
| --- | --- |
| Revealed token | `public, max-age=31536000, s-maxage=31536000, immutable` |
| Unrevealed token | `public, max-age=0, s-maxage=0, must-revalidate` |
| Minted but no metadata | `no-store` |
| `/status` | `no-store` |

The revealed case is safe to cache forever because a revealed token never
changes. The unrevealed case must not be cached anywhere, because it stops being
true the moment the token mints. Getting this wrong is the failure people notice:
the token mints, the buyer refreshes, and a CDN keeps handing them the
placeholder.

`npm run preflight -- --url https://your-server` checks both.

## Where the metadata lives

The server needs to read your metadata while the public cannot. Three options,
set with `metadata.source`:

`bundled` compiles your files into the deployment with
`npm run build:manifest`. Nothing external to set up, nothing else that can be
down during your mint. Right for most drops. Cloudflare caps a compressed worker
bundle at 3 MB on the free plan, so see
[large-drops.md](large-drops.md) if you have more than a few thousand tokens.

`r2` reads from a private Cloudflare R2 bucket, one object per position. Right for
large sets, and it keeps your metadata out of git entirely.

`http` reads from a private base URL you control, with an optional
`Authorization` header. A public IPFS gateway is not a private base URL: if your
set is pinned publicly and the shuffle is off, the gating becomes decorative.

## What runs where

`src/handler.ts` is the whole HTTP surface, and takes a `Request` and a runtime.
The three adapters build that runtime from their platform's environment and call
it. Nothing else is platform specific, which is why the tests can drive the real
handler with a fake chain and no network.

```
adapters/cloudflare.ts   ->  src/handler.ts  ->  src/mint-state.ts  ->  chain
api/index.ts (Vercel)                        ->  src/token-metadata.ts
adapters/node.ts                             ->  src/sources/*
```
