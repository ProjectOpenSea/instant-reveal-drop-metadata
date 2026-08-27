/**
 * Everything the server reads from its environment. Nothing secret lives in
 * `drop.config.ts`, so that file is safe to commit.
 *
 * On Cloudflare these are secrets (`wrangler secret put NAME`) or vars in
 * `wrangler.toml`. On Vercel they are project environment variables. Locally
 * they come from `.env` (Node) or `.dev.vars` (wrangler dev).
 */

import type { KvLike } from "./reveal-store.ts";

/** The slice of Cloudflare's R2 binding this server uses. */
export type R2Like = {
  get(key: string): Promise<{ text(): Promise<string> } | null>;
};

export type Env = {
  /** JSON-RPC endpoint. Strongly recommended: the public defaults are shared. */
  RPC_URL?: string;

  /** Secret seed for the optional shuffle. Never commit this. */
  SHUFFLE_SEED?: string;

  /**
   * Set to "true" once your mint is over to publish SHUFFLE_SEED at
   * /provenance, so holders can verify the mapping themselves.
   */
  PUBLISH_SEED?: string;

  /**
   * Emergency switch. Set to "true" to reveal everything at once, for example
   * after your drop mints out and before you migrate to IPFS.
   */
  REVEAL_ALL?: string;

  /**
   * Signing key from an Alchemy Notify webhook, enabling POST /webhook/alchemy.
   * Without it that route returns 404, so an unconfigured server has no
   * unauthenticated write surface at all.
   */
  ALCHEMY_WEBHOOK_SIGNING_KEY?: string;

  /**
   * Shared secret for the provider agnostic POST /webhook/mint route. Send it
   * as `Authorization: Bearer <secret>`.
   */
  WEBHOOK_SECRET?: string;

  /** For metadata.source "http". */
  METADATA_HTTP_BASE_URL?: string;
  METADATA_HTTP_AUTHORIZATION?: string;

  /** For metadata.source "r2". Bound in wrangler.toml, not a string. */
  METADATA_BUCKET?: R2Like;

  /**
   * Optional Cloudflare KV namespace. When bound, mint progress is shared
   * across every instance of the worker, so a webhook that arrives at one of
   * them reveals the token everywhere.
   */
  REVEAL_STATE?: KvLike;
};

export function envFlag(value: string | undefined): boolean {
  if (!value) return false;
  return ["1", "true", "yes", "on"].includes(value.trim().toLowerCase());
}

/**
 * Pull the variables we care about out of a plain string map, which is what
 * `process.env` is on Node and Vercel. Cloudflare passes its own object
 * straight through instead.
 */
export function envFromRecord(source: Record<string, string | undefined>): Env {
  return {
    RPC_URL: source["RPC_URL"],
    SHUFFLE_SEED: source["SHUFFLE_SEED"],
    PUBLISH_SEED: source["PUBLISH_SEED"],
    REVEAL_ALL: source["REVEAL_ALL"],
    ALCHEMY_WEBHOOK_SIGNING_KEY: source["ALCHEMY_WEBHOOK_SIGNING_KEY"],
    WEBHOOK_SECRET: source["WEBHOOK_SECRET"],
    METADATA_HTTP_BASE_URL: source["METADATA_HTTP_BASE_URL"],
    METADATA_HTTP_AUTHORIZATION: source["METADATA_HTTP_AUTHORIZATION"],
  };
}
