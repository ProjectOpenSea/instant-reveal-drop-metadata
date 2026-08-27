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
token 2, and so on. With the shuffle on, position still comes from this order and
the seed decides which position each token ID lands on.

Either way, renaming files between builds changes which artwork a token gets, so
settle on an order before publishing anything.

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
mint: an image alone does not say which token ID it belongs to. The server
withholds the mapping, not the artwork.

If your metadata files use relative image paths, set `metadata.imageBaseUri` in
`drop.config.ts` and the server will prefix them.

## This directory is gitignored

Deliberately, so your unrevealed set does not end up in a public repository.

`npm run build:manifest` copies the same data into `src/generated/manifest.ts`,
which cannot be ignored because the deployment needs it. So that file is guarded
instead: `npm run check:privacy` fails if it is staged or committed with entries
in it, it runs in CI, and `build:manifest` installs it as a pre-commit hook. Use
`metadata.source: "r2"` to keep metadata out of git entirely, or
`ALLOW_METADATA_IN_GIT=1` if your repository is private and staying that way. See
`docs/security.md`.

`metadata/example/` holds four sample files for trying things out:

```bash
npm run build:manifest -- --dir metadata/example
```
