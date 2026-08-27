/**
 * Turns a token ID into the JSON body we serve, either the real thing or the
 * placeholder.
 *
 * The only interesting part is the token ID to artwork mapping:
 *
 *   position = tokenId - tokenIdStart          0 for the first token
 *   index    = shuffle ? permutation[position] : position
 *
 * A token's artwork therefore never depends on when it was minted or by whom,
 * only on its ID. That is worth understanding, because it is why a chain reorg
 * cannot hand someone else's artwork to the wrong token: the mapping was fixed
 * before the mint opened.
 */

import type { ResolvedConfig, TokenMetadata } from "./config.ts";
import { buildPermutation } from "./shuffle.ts";
import type { MetadataSource } from "./sources/index.ts";

const ABSOLUTE_URI = /^[a-z][a-z0-9+.-]*:/i;

export type MappingStatus = {
  shuffle: "off" | "ready" | "missing-seed";
  commitment: string | null;
};

export class TokenMetadataBuilder {
  private readonly config: ResolvedConfig;
  private readonly source: MetadataSource;
  private readonly seed: string | undefined;
  private permutation: Promise<number[]> | null = null;

  constructor(config: ResolvedConfig, source: MetadataSource, seed?: string) {
    this.config = config;
    this.source = source;
    this.seed = seed && seed.length > 0 ? seed : undefined;
  }

  inRange(tokenId: number): boolean {
    return tokenId >= this.config.tokenIdStart && tokenId <= this.config.tokenIdEnd;
  }

  mappingStatus(): MappingStatus {
    if (!this.config.reveal.shuffle.enabled) {
      return { shuffle: "off", commitment: null };
    }
    return {
      shuffle: this.seed ? "ready" : "missing-seed",
      commitment: this.config.reveal.shuffle.commitment ?? null,
    };
  }

  /**
   * Which entry of your metadata set this token gets, or null when the shuffle
   * is switched on but the seed is missing. Returning null there is
   * deliberate: guessing would serve the unshuffled order, which is both the
   * wrong artwork and a leak of the order you were trying to hide.
   */
  async indexForToken(tokenId: number): Promise<number | null> {
    const position = tokenId - this.config.tokenIdStart;
    if (position < 0 || position >= this.config.maxSupply) return null;
    if (!this.config.reveal.shuffle.enabled) return position;
    if (!this.seed) return null;

    if (!this.permutation) {
      this.permutation = buildPermutation(this.seed, this.config.maxSupply);
    }
    const permutation = await this.permutation;
    return permutation[position] ?? null;
  }

  /** The real metadata, or null if we cannot produce it. */
  async revealed(tokenId: number): Promise<TokenMetadata | null> {
    const index = await this.indexForToken(tokenId);
    if (index === null) return null;

    const entry = await this.source.get(index);
    if (!entry) return null;

    return this.applyBaseUri(entry);
  }

  placeholder(tokenId: number): TokenMetadata {
    const filled = fillTemplates(this.config.placeholder, tokenId);
    return this.applyBaseUri(filled);
  }

  /**
   * Prefix `imageBaseUri` onto media paths that are relative. Metadata that
   * already carries full URIs passes through untouched.
   */
  private applyBaseUri(entry: TokenMetadata): TokenMetadata {
    const base = this.config.metadata.imageBaseUri;
    if (!base) return entry;

    const prefix = base.endsWith("/") ? base : `${base}/`;
    const out: TokenMetadata = { ...entry };
    for (const field of ["image", "image_url", "animation_url"] as const) {
      const value = out[field];
      if (typeof value === "string" && value.length > 0 && !ABSOLUTE_URI.test(value)) {
        out[field] = prefix + value.replace(/^\/+/, "");
      }
    }
    return out;
  }
}

/** Substitute {tokenId} in every string of the placeholder. */
function fillTemplates(value: TokenMetadata, tokenId: number): TokenMetadata {
  const out: TokenMetadata = {};
  for (const [key, raw] of Object.entries(value)) {
    out[key] = typeof raw === "string" ? raw.replaceAll("{tokenId}", String(tokenId)) : raw;
  }
  return out;
}
