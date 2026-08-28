# Deploying

> Five hosts, in the order most people should consider them, and the one command
> to run against each afterwards.

All five serve the same code from `src/handler.ts`.

| Option | Account needed | Good for |
| --- | --- | --- |
| Cloudflare Workers | Cloudflare | A live mint. Free plan covers 100k requests a day. |
| Vercel | Vercel | A live mint, if you are already on Vercel. |
| Deno Deploy | GitHub login | A live mint, if you would rather not touch a CLI. |
| Any Node host | Whatever the host needs | A live mint, if you already run servers. |
| Your machine plus a tunnel | None at all | Trying it out, and test drops. Not a live mint. |

## Cloudflare Workers

One command, no build step, and the free plan is enough for a normal drop.

```bash
npm run build:manifest
npm run deploy
```

The first run opens a browser to authorise the CLI and prints a `*.workers.dev`
URL. Set your secrets after that:

```bash
npx wrangler secret put RPC_URL
```

Optional, and only if you use them:

```bash
npx wrangler secret put SHUFFLE_SEED
npx wrangler secret put ALCHEMY_WEBHOOK_SIGNING_KEY
npx wrangler secret put WEBHOOK_SECRET
```

Redeploy after changing `drop.config.ts` or rebuilding the manifest. Secrets do
not need a redeploy.

For a custom domain, add a route in `wrangler.toml` or attach one in the
Cloudflare dashboard. Whatever hostname you settle on goes into `setBaseURI`, so
pick it before pointing the contract at anything.

### Sharing mint progress between instances

Only worth doing if you run a webhook, and worth less than it sounds. Setup and
the honest version of what it buys you are in
[webhooks.md](webhooks.md#serverless-hosts-need-one-more-step).

## Vercel

```bash
npm run build:manifest
npx vercel --prod
```

`vercel.json` rewrites every path to `api/index.ts`, which runs as an edge
function. Set environment variables in the project settings or with
`npx vercel env add RPC_URL`.

R2 is Cloudflare specific, so on Vercel use `metadata.source: "bundled"` or
`"http"`.

## Deno Deploy

Deno runs the Node adapter through its Node compatibility layer. Create a project
from your GitHub repository, set the entry point to `adapters/node.ts`, and add
`RPC_URL` as an environment variable. No CLI step and no build. This path is the
least exercised of the five, so run `npm run preflight -- --url ...` against it
before pointing a contract at it.

## Any Node host

Fly, Render, Railway, a container, an EC2 box, anything that runs a process:

```bash
npm ci
npm run build:manifest
PORT=8787 node adapters/node.ts
```

Node 22.18 or newer, which is where running TypeScript directly stopped needing a
flag. No build step, no bundler.

## Your machine plus a tunnel

The fastest way to see it working, with nothing to sign up for. Good for a test
drop. Not for a real mint: the URL disappears when you close your laptop, and a
`baseURI` pointing at a dead host means every token looks broken.

```bash
npm run dev
npx cloudflared tunnel --url http://localhost:8787   # second terminal
```

That prints a `https://something-random.trycloudflare.com` URL, live immediately,
no account and no login. GitHub Codespaces forwarded ports do the same job, with
the port set to public.

Full walkthrough, including minting and watching the reveal land, in
[test-run.md](test-run.md).

## Whichever you choose

Check the deployed server against the live contract before you point the contract
at it:

```bash
npm run preflight -- --url https://your-server
```

Then set the base URI, from the wallet that owns the drop, remembering the
trailing slash:

```bash
cast send <contract> "setBaseURI(string)" "https://your-server/" \
  --rpc-url $RPC_URL --private-key $KEY
```

`setBaseURI` is also callable from Etherscan's write tab with the owner wallet
connected. Run preflight once more afterwards, so the two are checked against
each other now that they point at each other.
