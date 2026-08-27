# Your metadata goes here

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
token 2, and so on.

With the shuffle on, position still comes from this order, and the seed decides
which position each token ID lands on. Either way, renaming files between builds
changes which artwork a token gets, so settle on an order before you publish
anything.

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

On IPFS, pinned, exactly as normal. Images are fine to make public before the
mint, because an image on its own does not tell anyone which token ID it belongs
to. It is the mapping this server withholds, not the artwork.

If your metadata files use relative image paths, set `metadata.imageBaseUri` in
`drop.config.ts` and the server will prefix them.

## This directory is gitignored

Deliberately. `metadata/*` is excluded so your unrevealed set does not end up in
a public repository. `npm run build:manifest` writes it into
`src/generated/manifest.ts`, which is not ignored, so if you push your copy of
this repo anywhere public, either keep that repo private or use
`metadata.source: "r2"` instead. See `docs/security.md`.

`metadata/example/` holds four sample files for trying things out:

```bash
npm run build:manifest -- --dir metadata/example
```
