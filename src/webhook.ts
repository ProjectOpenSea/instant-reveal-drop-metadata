/**
 * Push notifications of mints, so a reveal lands in about a second instead of
 * waiting for the next poll.
 *
 * Two routes, both optional, both off until you set their secret:
 *
 *   POST /webhook/alchemy   an Alchemy Notify webhook (NFT activity, address
 *                           activity, or a custom GraphQL webhook), verified
 *                           against ALCHEMY_WEBHOOK_SIGNING_KEY
 *   POST /webhook/mint      any other provider, or your own script. Send
 *                           `Authorization: Bearer $WEBHOOK_SECRET` and a body
 *                           of {"tokenIds":[1,2,3]}, or {"revealedThrough":500}
 *                           on a "sequential" drop
 *
 * A webhook can only ever say "this token exists now". It cannot hide a token,
 * cannot lower the high water mark, and is not required for correctness: the
 * poller keeps running underneath and catches anything a webhook misses. If you
 * never configure one, nothing changes except reveal latency.
 *
 * If no secret is configured the route answers 404, so a default deployment has
 * no unauthenticated write surface.
 */

import type { Env } from "./env.ts";
import type { Runtime } from "./runtime.ts";

/** keccak256("Transfer(address,address,uint256)") */
const TRANSFER_TOPIC = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";

const MAX_BODY_BYTES = 2_000_000;
const MAX_TOKEN_IDS = 10_000;

export type WebhookResult = {
  status: number;
  body: Record<string, unknown>;
};

export function isWebhookPath(path: string): boolean {
  return path === "/webhook/alchemy" || path === "/webhook/mint";
}

export async function handleWebhook(
  request: Request,
  runtime: Runtime,
  env: Env,
  path: string,
): Promise<WebhookResult> {
  if (path === "/webhook/alchemy") return handleAlchemy(request, runtime, env);
  if (path === "/webhook/mint") return handleGeneric(request, runtime, env);
  return { status: 404, body: { error: "not found" } };
}

async function handleAlchemy(request: Request, runtime: Runtime, env: Env): Promise<WebhookResult> {
  const signingKey = env.ALCHEMY_WEBHOOK_SIGNING_KEY;
  if (!signingKey) {
    return {
      status: 404,
      body: { error: "webhook not enabled, set ALCHEMY_WEBHOOK_SIGNING_KEY to turn it on" },
    };
  }

  const raw = await readBody(request);
  if (raw === null) return { status: 413, body: { error: "body too large" } };

  const provided = request.headers.get("x-alchemy-signature") ?? "";
  const expected = await hmacSha256Hex(signingKey, raw);
  if (!timingSafeEqual(provided.toLowerCase(), expected)) {
    return { status: 401, body: { error: "signature does not match" } };
  }

  let payload: unknown;
  try {
    payload = JSON.parse(raw);
  } catch {
    return { status: 400, body: { error: "body is not JSON" } };
  }

  const tokenIds = extractMintedTokenIds(payload, runtime.config.contract);
  const applied = await runtime.mintState.recordMintedTokens(tokenIds);

  return {
    status: 200,
    body: {
      ok: true,
      source: "alchemy",
      tokenIdsSeen: tokenIds.length,
      tokenIdsApplied: applied,
      revealedThrough: runtime.mintState.status().highestMintedTokenId,
    },
  };
}

async function handleGeneric(request: Request, runtime: Runtime, env: Env): Promise<WebhookResult> {
  const secret = env.WEBHOOK_SECRET;
  if (!secret) {
    return {
      status: 404,
      body: { error: "webhook not enabled, set WEBHOOK_SECRET to turn it on" },
    };
  }

  const authorization = request.headers.get("authorization") ?? "";
  const bearer = authorization.replace(/^Bearer\s+/i, "");
  if (!timingSafeEqual(bearer, secret)) {
    return { status: 401, body: { error: "bad or missing bearer token" } };
  }

  const raw = await readBody(request);
  if (raw === null) return { status: 413, body: { error: "body too large" } };

  let payload: { tokenIds?: unknown; tokenId?: unknown; revealedThrough?: unknown };
  try {
    payload = JSON.parse(raw) as typeof payload;
  } catch {
    return { status: 400, body: { error: "body is not JSON" } };
  }

  const tokenIds: number[] = [];
  if (Array.isArray(payload.tokenIds)) {
    for (const value of payload.tokenIds.slice(0, MAX_TOKEN_IDS)) {
      const parsed = parseTokenId(value);
      if (parsed !== null) tokenIds.push(parsed);
    }
  }
  const single = parseTokenId(payload.tokenId);
  if (single !== null) tokenIds.push(single);

  // "revealedThrough" is a convenience for an indexer that tracks supply
  // rather than individual mints: everything up to this ID is minted.
  //
  // It works by raising the high water mark, and only sequential mode reads
  // one. ownerOf mode asks the chain about each token ID separately, precisely
  // because a drop configured that way cannot assume the IDs below a number
  // exist. Accepting the field there would reveal token n and quietly drop the
  // "through" part, which is a wrong answer that looks like a successful
  // delivery, so refuse it and say what to send instead.
  if (payload.revealedThrough !== undefined && runtime.config.mintState.mode === "ownerOf") {
    return {
      status: 400,
      body: {
        error:
          'revealedThrough needs mintState.mode "sequential", and this drop is "ownerOf". ' +
          "That mode makes no assumption that the token IDs below a number are minted, so " +
          "send the individual ids as tokenIds: [..] instead.",
      },
    };
  }

  const through = parseTokenId(payload.revealedThrough);
  if (through !== null) tokenIds.push(through);

  if (tokenIds.length === 0) {
    return {
      status: 400,
      body: { error: "send tokenIds: [..], tokenId: n, or revealedThrough: n" },
    };
  }

  const applied = await runtime.mintState.recordMintedTokens(tokenIds);
  return {
    status: 200,
    body: {
      ok: true,
      source: "generic",
      tokenIdsSeen: tokenIds.length,
      tokenIdsApplied: applied,
      revealedThrough: runtime.mintState.status().highestMintedTokenId,
    },
  };
}

/**
 * Pull token IDs for our contract out of whatever shape the provider sent.
 *
 * Alchemy has several payload formats and changes them from time to time, so
 * rather than matching one exactly this walks the JSON and picks up anything
 * that identifies a token on our contract: `erc721TokenId` fields on activity
 * entries, and raw Transfer logs from a custom GraphQL webhook.
 *
 * Any activity for a token proves the token exists, which is all we need, so
 * there is no need to single out mints from transfers.
 */
export function extractMintedTokenIds(payload: unknown, contract: string): number[] {
  const target = contract.toLowerCase();
  const found = new Set<number>();

  const visit = (node: unknown, depth: number): void => {
    if (found.size >= MAX_TOKEN_IDS || depth > 12 || node === null || typeof node !== "object") {
      return;
    }

    if (Array.isArray(node)) {
      for (const item of node) visit(item, depth + 1);
      return;
    }

    const record = node as Record<string, unknown>;

    // Shape 1: NFT activity and address activity entries.
    if (typeof record.contractAddress === "string") {
      if ((record.contractAddress as string).toLowerCase() === target) {
        const tokenId = parseTokenId(record.erc721TokenId);
        if (tokenId !== null) found.add(tokenId);

        const erc1155 = record.erc1155Metadata;
        if (Array.isArray(erc1155)) {
          for (const entry of erc1155) {
            if (entry && typeof entry === "object") {
              const parsed = parseTokenId((entry as Record<string, unknown>).tokenId);
              if (parsed !== null) found.add(parsed);
            }
          }
        }
      }
    }

    // Shape 2: raw logs from a custom GraphQL webhook.
    const topics = record.topics;
    if (Array.isArray(topics) && topics.length === 4 && typeof topics[0] === "string") {
      const logAddress = logAddressOf(record);
      if (
        logAddress === target &&
        (topics[0] as string).toLowerCase() === TRANSFER_TOPIC &&
        typeof topics[3] === "string"
      ) {
        const parsed = parseTokenId(topics[3]);
        if (parsed !== null) found.add(parsed);
      }
    }

    for (const value of Object.values(record)) visit(value, depth + 1);
  };

  visit(payload, 0);
  return [...found];
}

function logAddressOf(record: Record<string, unknown>): string | null {
  const direct = record.address;
  if (typeof direct === "string") return direct.toLowerCase();

  const account = record.account;
  if (account && typeof account === "object") {
    const nested = (account as Record<string, unknown>).address;
    if (typeof nested === "string") return nested.toLowerCase();
  }
  return null;
}

/** Accepts 12, "12", and "0x0c". Rejects anything that is not a safe integer. */
export function parseTokenId(value: unknown): number | null {
  if (typeof value === "number") {
    return Number.isSafeInteger(value) && value >= 0 ? value : null;
  }
  if (typeof value !== "string") return null;

  const trimmed = value.trim();
  if (!/^(0x[0-9a-f]+|\d+)$/i.test(trimmed)) return null;

  const parsed = BigInt(trimmed);
  if (parsed > BigInt(Number.MAX_SAFE_INTEGER)) return null;
  return Number(parsed);
}

async function readBody(request: Request): Promise<string | null> {
  const declared = request.headers.get("content-length");
  if (declared && Number(declared) > MAX_BODY_BYTES) return null;

  const raw = await request.text();
  // Measure bytes, not characters. `String.length` counts UTF-16 code units,
  // so a body of multi-byte characters is up to three times the limit before
  // this notices.
  if (new TextEncoder().encode(raw).length > MAX_BODY_BYTES) return null;
  return raw;
}

async function hmacSha256Hex(secret: string, message: string): Promise<string> {
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret) as unknown as ArrayBuffer,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign(
    "HMAC",
    key,
    encoder.encode(message) as unknown as ArrayBuffer,
  );
  return Array.from(new Uint8Array(signature), (b) => b.toString(16).padStart(2, "0")).join("");
}

/** Compares without leaking where two strings first differ. */
export function timingSafeEqual(a: string, b: string): boolean {
  if (a.length === 0 || b.length === 0) return false;

  let mismatch = a.length === b.length ? 0 : 1;
  const length = Math.max(a.length, b.length);
  for (let i = 0; i < length; i++) {
    // charCodeAt past the end is NaN, and ToInt32(NaN) is 0.
    mismatch |= (a.charCodeAt(i) | 0) ^ (b.charCodeAt(i) | 0);
  }
  return mismatch === 0;
}
