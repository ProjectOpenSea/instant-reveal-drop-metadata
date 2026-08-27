/**
 * The whole HTTP surface. Five routes, and one rule that matters more than the
 * rest of this repository put together:
 *
 *   a revealed token may be cached forever, an unrevealed one may not be
 *   cached at all
 *
 * If a CDN is allowed to hold on to an "unrevealed" response, the token mints
 * and buyers keep seeing the placeholder until that entry expires. That is the
 * failure people will notice, so the headers are set in one place and the
 * tests check them.
 */

import type { TokenMetadata } from "./config.ts";
import { rpcHost, type Runtime } from "./runtime.ts";
import { handleWebhook, isWebhookPath } from "./webhook.ts";

const CORS_HEADERS: Record<string, string> = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET, HEAD, OPTIONS",
  "access-control-allow-headers": "content-type",
  "access-control-max-age": "86400",
};

/** Webhook replies are for the provider, not a browser. No CORS, never cached. */
function webhookResponse(body: Record<string, unknown>, status: number): Response {
  return new Response(JSON.stringify(body, null, 2) + "\n", {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
    },
  });
}

const TOKEN_PATH = /^(\d{1,78})(?:\.json)?$/;

export async function handleRequest(request: Request, runtime: Runtime): Promise<Response> {
  if (request.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: CORS_HEADERS });
  }

  const url = new URL(request.url);
  const path = url.pathname.replace(/\/+$/, "");

  if (isWebhookPath(path)) {
    if (request.method !== "POST") {
      return webhookResponse({ error: "webhooks are POST only" }, 405);
    }
    const result = await handleWebhook(request, runtime, runtime.env, path);
    return webhookResponse(result.body, result.status);
  }

  if (request.method !== "GET" && request.method !== "HEAD") {
    return json({ error: "method not allowed" }, { status: 405, cacheControl: "no-store" });
  }

  const response = await route(path, runtime, url);

  // A HEAD response carries the headers of the GET it stands in for, no body.
  if (request.method === "HEAD") {
    return new Response(null, { status: response.status, headers: response.headers });
  }
  return response;
}

async function route(path: string, runtime: Runtime, url: URL): Promise<Response> {
  switch (path) {
    case "":
      return json(indexBody(runtime, url), { cacheControl: "public, max-age=60" });
    case "/health":
      return new Response("ok\n", {
        status: 200,
        headers: { ...CORS_HEADERS, "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" },
      });
    case "/status":
      return json(await statusBody(runtime), { cacheControl: "no-store" });
    case "/provenance":
      return json(provenanceBody(runtime), { cacheControl: "public, max-age=60" });
    case "/contract":
    case "/contract.json":
      return runtime.config.contractMetadata
        ? json(runtime.config.contractMetadata, { cacheControl: "public, max-age=300" })
        : json({ error: "no contract level metadata configured" }, { status: 404, cacheControl: "public, max-age=60" });
  }

  // Anything else is a token request. We read the last path segment so the
  // server works whether your baseURI is https://host/ or https://host/meta/.
  const lastSegment = path.slice(path.lastIndexOf("/") + 1);
  const match = TOKEN_PATH.exec(lastSegment);
  if (!match) {
    return json({ error: "not found" }, { status: 404, cacheControl: "public, max-age=60" });
  }

  return serveToken(Number(match[1]), runtime);
}

async function serveToken(tokenId: number, runtime: Runtime): Promise<Response> {
  const { builder, config } = runtime;

  if (!builder.inRange(tokenId)) {
    return json(
      {
        error: "token id outside this drop",
        tokenIdStart: config.tokenIdStart,
        tokenIdEnd: config.tokenIdEnd,
      },
      { status: 404, cacheControl: "public, max-age=60" },
    );
  }

  const decision = await runtime.mintState.decide(tokenId, runtime.revealAll);

  if (!decision.revealed) {
    return tokenResponse(builder.placeholder(tokenId), {
      state: decision.reason,
      // An "unrevealed" answer is a snapshot of right now, and stops being true
      // the moment the token mints. Nothing may cache it.
      cacheControl: unrevealedCacheControl(runtime),
    });
  }

  const metadata = await builder.revealed(tokenId);
  if (!metadata) {
    // Minted, but we cannot produce metadata: an unbuilt manifest, a missing
    // file, or the shuffle seed is not set. Serve the placeholder rather than
    // an error, so marketplaces do not record a broken token, and make the
    // reason visible in the headers and at /status.
    return tokenResponse(builder.placeholder(tokenId), {
      state: "metadata-missing",
      cacheControl: "no-store",
      status: 200,
    });
  }

  return tokenResponse(metadata, {
    state: decision.reason,
    cacheControl: `public, max-age=${runtime.config.cache.revealedMaxAge}, s-maxage=${runtime.config.cache.revealedMaxAge}, immutable`,
  });
}

function unrevealedCacheControl(runtime: Runtime): string {
  const maxAge = runtime.config.cache.unrevealedMaxAge;
  if (maxAge <= 0) return "public, max-age=0, s-maxage=0, must-revalidate";
  return `public, max-age=${maxAge}, s-maxage=${maxAge}`;
}

function tokenResponse(
  body: TokenMetadata,
  options: { state: string; cacheControl: string; status?: number },
): Response {
  return json(body, {
    status: options.status ?? 200,
    cacheControl: options.cacheControl,
    headers: { "x-reveal-state": options.state },
  });
}

function indexBody(runtime: Runtime, url: URL): Record<string, unknown> {
  const origin = `${url.protocol}//${url.host}`;
  return {
    service: "instant-reveal-drop-metadata",
    contract: runtime.config.contract,
    chain: runtime.config.chain,
    tokenIds: `${runtime.config.tokenIdStart} to ${runtime.config.tokenIdEnd}`,
    baseUriToSetOnYourContract: `${origin}/`,
    example: `${origin}/${runtime.config.tokenIdStart}`,
    endpoints: {
      token: "/{tokenId}",
      status: "/status",
      provenance: "/provenance",
      health: "/health",
      webhooks: ["POST /webhook/alchemy", "POST /webhook/mint"],
    },
    source: "https://github.com/ProjectOpenSea/instant-reveal-drop-metadata",
  };
}

async function statusBody(runtime: Runtime): Promise<Record<string, unknown>> {
  const { config, builder, source } = runtime;
  const mintState = runtime.mintState.status();
  const mapping = builder.mappingStatus();

  const problems: string[] = [];
  if (!source.ready()) problems.push(source.describe());
  if (mapping.shuffle === "missing-seed") {
    problems.push("reveal.shuffle is enabled but SHUFFLE_SEED is not set, so nothing can be revealed");
  }

  // A source that knows its own size can be checked against the drop. Coming up
  // short means some tokens will mint and then sit on the placeholder forever.
  const entries = source.size();
  if (entries !== null && entries > 0 && entries < config.maxSupply) {
    problems.push(
      `only ${entries} metadata entries for ${config.maxSupply} tokens, so tokens ` +
        `${config.tokenIdStart + entries} and above have nothing to reveal`,
    );
  }

  if (mintState.lastError) problems.push(`last RPC error: ${mintState.lastError}`);

  return {
    ok: problems.length === 0,
    problems,
    drop: {
      chain: config.chain,
      contract: config.contract,
      tokenIdStart: config.tokenIdStart,
      tokenIdEnd: config.tokenIdEnd,
      maxSupply: config.maxSupply,
    },
    reveal: {
      mode: runtime.revealAll ? "always (REVEAL_ALL is set)" : config.reveal.mode,
      shuffle: mapping.shuffle,
      revealedThrough: mintState.highestMintedTokenId,
    },
    mintState,
    webhooks: {
      alchemy: runtime.env.ALCHEMY_WEBHOOK_SIGNING_KEY ? "enabled" : "not configured",
      generic: runtime.env.WEBHOOK_SECRET ? "enabled" : "not configured",
      note: "webhooks only speed reveals up, polling still runs underneath",
    },
    revealStore: runtime.store.describe(),
    metadataSource: { kind: source.kind, entries: source.size(), detail: source.describe() },
    rpc: { host: rpcHost(runtime.rpcUrl) },
    cache: config.cache,
    uptimeSeconds: Math.round((Date.now() - runtime.startedAtMs) / 1000),
  };
}

function provenanceBody(runtime: Runtime): Record<string, unknown> {
  const shuffleEnabled = runtime.config.reveal.shuffle.enabled;
  return {
    contract: runtime.config.contract,
    chain: runtime.config.chain,
    tokenIdStart: runtime.config.tokenIdStart,
    maxSupply: runtime.config.maxSupply,
    manifestHash: runtime.manifestHash || null,
    shuffle: shuffleEnabled
      ? {
          enabled: true,
          algorithm: "sha256 seeded splitmix64, Fisher-Yates, see src/shuffle.ts",
          commitment: runtime.config.reveal.shuffle.commitment ?? null,
          // The seed stays secret until the creator sets PUBLISH_SEED, which
          // should happen once minting is done.
          seed: runtime.publishSeed ? (runtime.seed ?? null) : null,
          seedPublished: runtime.publishSeed,
        }
      : { enabled: false },
    howToVerify:
      "https://github.com/ProjectOpenSea/instant-reveal-drop-metadata/blob/main/docs/verify-a-shuffle.md",
  };
}

function json(
  body: unknown,
  options: { status?: number; cacheControl: string; headers?: Record<string, string> },
): Response {
  return new Response(JSON.stringify(body, null, 2) + "\n", {
    status: options.status ?? 200,
    headers: {
      ...CORS_HEADERS,
      ...options.headers,
      "content-type": "application/json; charset=utf-8",
      "cache-control": options.cacheControl,
    },
  });
}
