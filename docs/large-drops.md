# Large drops

The default setup compiles your metadata into the deployment. That is the right
choice up to a few thousand tokens, and stops being one somewhere above that.

`npm run build:manifest` tells you where you stand:

```
note  metadata JSON  4.10 MB
note  compressed     412 KB (what counts against a Workers bundle limit)
```

The compressed number is what matters. Cloudflare's limit on a worker bundle is
3 MB on the free plan and 10 MB on the paid one. Metadata JSON compresses well,
often ten to one, so a 10,000 token set frequently still fits. The build script
warns at 70 percent of the free limit and fails past it.

Vercel and a plain Node process have no comparable limit, so bundling a large set
there is only a question of memory.

## Option 1, Cloudflare R2

One object per position, read on demand, cached in memory after the first read.
Metadata never enters git, which also removes the main way people accidentally
publish their unrevealed set.

```bash
npx wrangler r2 bucket create my-drop-metadata
```

Uncomment the `r2_buckets` block in `wrangler.toml` and set the bucket name. Then
in `drop.config.ts`:

```ts
metadata: {
  source: "r2",
  pathTemplate: "{index}.json",
}
```

Upload your files, named by zero based position, so token 1 with
`tokenIdStart: 1` reads `0.json`:

```bash
for i in $(seq 0 9999); do
  npx wrangler r2 object put "my-drop-metadata/$i.json" --file "metadata/$((i + 1)).json"
done
```

That loop is slow for ten thousand files. `rclone` with an S3 remote pointed at
R2 is much faster, and so is the R2 dashboard's bulk upload.

Set the manifest hash by hand if you want `/provenance` to report one, using the
value `npm run build:manifest` printed:

```ts
metadata: {
  source: "r2",
  manifestHash: "e2ce2f...",
}
```

R2 buckets are private unless you attach a public domain to them. Do not attach
one.

## Option 2, a private HTTP base URL

Any host you control, with an optional `Authorization` header:

```ts
metadata: { source: "http", pathTemplate: "{index}.json" }
```

```bash
METADATA_HTTP_BASE_URL=https://private.example.com/drop
METADATA_HTTP_AUTHORIZATION=Bearer some-token
```

A private S3 or GCS bucket behind a signed base, or a small origin of your own,
both work. A public IPFS gateway does not: if the set is publicly readable and
the shuffle is off, the gating this server does stops meaning anything. See
[security.md](security.md).

## Option 3, keep bundling but shrink the JSON

Sometimes the simplest fix. Long descriptions repeated across every token, or
per token `external_url` values, are usually most of the bytes. Trim what is
identical across the set, since it compresses but still costs.

## RPC load at scale

Independent of metadata size. The default `sequential` mode makes one
`totalSupply()` call per TTL window, whatever your traffic, so a 10,000 token
drop costs the same as a 100 token one: roughly six calls a minute.

`ownerOf` mode does scale with distinct tokens requested, one call each, cached
permanently once positive. For a large drop being indexed by several marketplaces
at once that is a real number of calls, so prefer `sequential` unless your
contract genuinely mints out of order.

## Cold starts

A serverless instance that has just started knows nothing, so the first request it
handles waits for one RPC round trip, typically under a second. Later requests
are served from memory. With many instances, each pays that once.

If you run a webhook with a KV store bound, new instances read the shared high
water mark instead, which removes most of the cold start cost. See
[webhooks.md](webhooks.md).
