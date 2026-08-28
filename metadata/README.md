# Your metadata goes here

> How to name and lay out your metadata files, and what the build refuses to
> guess. This page owns the naming rules.

Put one JSON file per token in this directory, named by position:

```
metadata/
  1.json
  2.json
  3.json
  ...
```

Or a single `metadata/manifest.json` holding an array, if that is what your
tooling produces.

Then compile it into the server:

```bash
npm run build:manifest
```

## What position means

The files are read in numeric order, and that order is what token IDs map to.
With `tokenIdStart: 1` and the shuffle off, `1.json` is token 1, `2.json` is
token 2, and so on. With the shuffle on, position still comes from this order and
the seed decides which position each token ID lands on.

Either way, renaming files between builds changes which artwork a token gets, so
settle on an order before publishing anything.

Because that order cannot be corrected once tokens are minted,
`npm run build:manifest` refuses to guess it. It stops when:

- two files claim the same position, such as `1.backup.json` next to `1.json`
- a number is missing from the run, which shifts everything after it
- a file is not named for a position at all, like `art-10.json`, which sorts
  before `art-2.json` as text
- the set does not start at 0 or 1, such as `5.json` through `1004.json`, which
  has no gaps and the right number of entries and would still put the wrong
  artwork on every token

Use `manifest.json` when you want to state the order explicitly instead. The
build also prints which file became which token, which is worth a glance before
you deploy.

## What goes in a file

The standard OpenSea metadata shape. Nothing here is specific to this server:

```json
{
  "name": "Example #1",
  "description": "One of a thousand.",
  "image": "ipfs://bafybeiexampleexampleexampleexample/1.png",
  "attributes": [
    { "trait_type": "Background", "value": "Blue" },
    { "trait_type": "Eyes", "value": "Laser" }
  ]
}
```

Full field reference: https://docs.opensea.io/docs/metadata-standards

## Where your images should live

On IPFS, pinned, exactly as normal, and they are fine to make public before the
mint. The server withholds the mapping, not the artwork; see
[docs/security.md](../docs/security.md#what-it-does-not-hide) for why that is
enough.

If your metadata files use relative image paths, set `metadata.imageBaseUri` in
`drop.config.ts` and the server will prefix them.

## This directory is gitignored

Deliberately, so your unrevealed set does not end up in a public repository.
`npm run build:manifest` copies the same data into `src/generated/manifest.ts`,
which cannot be ignored because the deployment needs it, so that file is guarded
by `npm run check:privacy` instead. How the guard works and how to opt out are in
[docs/security.md](../docs/security.md#the-mistake-to-avoid).

`metadata/example/` holds four sample files for trying things out:

```bash
npm run build:manifest -- --dir metadata/example
```
