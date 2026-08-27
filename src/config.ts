/**
 * Configuration types for the instant reveal metadata server.
 *
 * You edit `drop.config.ts` in the project root, not this file. Everything here
 * exists so your editor can tell you when a value is missing or misspelled.
 */

/** A single token's metadata, in the standard OpenSea metadata shape. */
export type TokenMetadata = {
  name?: string;
  description?: string;
  image?: string;
  image_url?: string;
  animation_url?: string;
  external_url?: string;
  background_color?: string;
  attributes?: Array<{
    trait_type?: string;
    value: string | number;
    display_type?: string;
    max_value?: number;
  }>;
  [key: string]: unknown;
};

export type RevealMode =
  /** Reveal each token the moment its mint is visible onchain. The default. */
  | "on-mint"
  /** Everything is revealed immediately. Equivalent to publishing to IPFS up front. */
  | "always"
  /** Nothing is ever revealed. Useful for testing your placeholder. */
  | "never";

export type MintStateMode =
  /**
   * One `totalSupply()` call answers every token, because SeaDrop mints token
   * IDs in order. Cheapest and the right choice for an OpenSea Studio drop.
   */
  | "sequential"
  /**
   * One `ownerOf(tokenId)` call per token. Use this if your contract can mint
   * token IDs out of order (a custom mint function, an airdrop of high IDs).
   */
  | "ownerOf";

export type MetadataSourceKind =
  /** Metadata compiled into the deployment by `npm run build:manifest`. */
  | "bundled"
  /** Metadata read from a Cloudflare R2 bucket bound as METADATA_BUCKET. */
  | "r2"
  /** Metadata read from a private HTTP base URL. */
  | "http";

export type DropConfig = {
  /**
   * Chain the contract is deployed on. Used to pick a default RPC URL and to
   * build OpenSea links. Set RPC_URL in your environment to override the default.
   */
  chain: string;

  /** The drop contract address. */
  contract: string;

  /** First token ID the contract mints. SeaDrop starts at 1. */
  tokenIdStart: number;

  /** Total number of tokens in the drop. Must match the contract's maxSupply. */
  maxSupply: number;

  reveal: {
    mode: RevealMode;
    /**
     * Optional deterministic shuffle, so the token-to-artwork mapping is not
     * simply "token 1 is the first file you uploaded".
     *
     * Set the secret with SHUFFLE_SEED in your environment, and publish
     * `commitment` (printed by `npm run seed:new`) before your mint starts so
     * holders can later verify you did not reorder anything.
     */
    shuffle: {
      enabled: boolean;
      commitment?: string | null;
    };
  };

  mintState: {
    mode: MintStateMode;
    /** How long to trust a cached "not minted yet" answer. Seconds. */
    ttlSeconds: number;
    /**
     * Only treat a mint as final once this many blocks sit on top of it.
     * 0 is a sensible default: the artwork for a token ID never changes, so a
     * reorg can only reveal one token a few seconds early, never the wrong one.
     */
    confirmations?: number;
  };

  metadata: {
    source: MetadataSourceKind;
    /**
     * Prefix applied to `image` and `animation_url` values that are relative
     * paths. Leave empty if your metadata files already contain full URIs.
     * Example: "ipfs://bafy.../"
     */
    imageBaseUri?: string;
    /**
     * Where to find one token's metadata, for the `r2` and `http` sources.
     * `{index}` is the zero-based position in your metadata set.
     */
    pathTemplate?: string;
    /**
     * Hash of your complete metadata set, served at /provenance. The bundled
     * source fills this in for you. Set it by hand for `r2` and `http`, using
     * the value `npm run build:manifest` prints.
     */
    manifestHash?: string;
  };

  /**
   * What an unminted token looks like. `{tokenId}` is substituted anywhere in
   * `name` and `description`.
   */
  placeholder: TokenMetadata;

  /** Optional collection-level metadata, served at /contract.json. */
  contractMetadata?: TokenMetadata | null;

  cache?: {
    /**
     * Seconds a revealed token may be cached. A revealed token never changes,
     * so this should stay high.
     */
    revealedMaxAge?: number;
    /**
     * Seconds an unrevealed token may be cached. Keep this at 0. A cached
     * placeholder is the one way this setup can visibly break: the token mints,
     * but a CDN keeps serving "unrevealed" until the entry expires.
     */
    unrevealedMaxAge?: number;
  };
};

export type ResolvedConfig = DropConfig & {
  tokenIdEnd: number;
  metadata: DropConfig["metadata"] & { pathTemplate: string; imageBaseUri: string };
  mintState: DropConfig["mintState"] & { confirmations: number };
  cache: { revealedMaxAge: number; unrevealedMaxAge: number };
};

export class ConfigError extends Error {}

const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;

/**
 * Fill in defaults and reject a config that cannot work, with a message that
 * names the field. Runs once when the server starts.
 */
export function resolveConfig(input: DropConfig): ResolvedConfig {
  const problems: string[] = [];

  if (!input.contract || !ADDRESS_RE.test(input.contract)) {
    problems.push(`contract must be a 0x address, got ${JSON.stringify(input.contract)}`);
  }
  if (input.contract && /^0x0{40}$/.test(input.contract)) {
    problems.push("contract is still the placeholder 0x000... address; set your drop's address");
  }
  if (!Number.isInteger(input.tokenIdStart) || input.tokenIdStart < 0) {
    problems.push(`tokenIdStart must be a non-negative integer, got ${input.tokenIdStart}`);
  }
  if (!Number.isInteger(input.maxSupply) || input.maxSupply < 1) {
    problems.push(`maxSupply must be a positive integer, got ${input.maxSupply}`);
  }
  if (!input.chain) {
    problems.push('chain is required (for example "base" or "ethereum")');
  }
  if (input.reveal?.shuffle?.enabled && input.reveal.shuffle.commitment == null) {
    problems.push(
      "reveal.shuffle.enabled is true but reveal.shuffle.commitment is empty; run `npm run seed:new`",
    );
  }
  if (input.metadata?.source === "http" && !input.metadata.pathTemplate) {
    // Not fatal, the default covers it.
  }

  if (problems.length > 0) {
    throw new ConfigError(`drop.config.ts is not usable yet:\n  - ${problems.join("\n  - ")}`);
  }

  return {
    ...input,
    tokenIdEnd: input.tokenIdStart + input.maxSupply - 1,
    metadata: {
      ...input.metadata,
      imageBaseUri: input.metadata.imageBaseUri ?? "",
      pathTemplate: input.metadata.pathTemplate ?? "{index}.json",
    },
    mintState: {
      ...input.mintState,
      confirmations: input.mintState.confirmations ?? 0,
    },
    cache: {
      revealedMaxAge: input.cache?.revealedMaxAge ?? 31_536_000,
      unrevealedMaxAge: input.cache?.unrevealedMaxAge ?? 0,
    },
  };
}
