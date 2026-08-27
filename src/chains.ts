/**
 * Chain slugs, matching the names OpenSea uses in its API and URLs.
 *
 * The RPC URLs here are free public endpoints, good enough to get you running
 * and rate limited enough that you should not mint 10,000 tokens against them.
 * Set RPC_URL in your environment to point at your own node (Alchemy, Infura,
 * QuickNode, dRPC, or anything else that speaks JSON-RPC).
 */
export type ChainInfo = {
  chainId: number;
  defaultRpcUrl: string;
  /** Only when OpenSea's API names the chain differently to the key here. */
  openseaSlug?: string;
};

export const CHAINS: Record<string, ChainInfo> = {
  ethereum: { chainId: 1, defaultRpcUrl: "https://ethereum-rpc.publicnode.com" },
  base: { chainId: 8453, defaultRpcUrl: "https://base-rpc.publicnode.com" },
  matic: { chainId: 137, defaultRpcUrl: "https://polygon-bor-rpc.publicnode.com" },
  polygon: {
    chainId: 137,
    defaultRpcUrl: "https://polygon-bor-rpc.publicnode.com",
    openseaSlug: "matic",
  },
  arbitrum: { chainId: 42161, defaultRpcUrl: "https://arbitrum-one-rpc.publicnode.com" },
  optimism: { chainId: 10, defaultRpcUrl: "https://optimism-rpc.publicnode.com" },
  avalanche: { chainId: 43114, defaultRpcUrl: "https://avalanche-c-chain-rpc.publicnode.com" },
  blast: { chainId: 81457, defaultRpcUrl: "https://blast-rpc.publicnode.com" },
  zora: { chainId: 7777777, defaultRpcUrl: "https://rpc.zora.energy" },
  sei: { chainId: 1329, defaultRpcUrl: "https://evm-rpc.sei-apis.com" },
  ape_chain: { chainId: 33139, defaultRpcUrl: "https://rpc.apechain.com" },
  unichain: { chainId: 130, defaultRpcUrl: "https://mainnet.unichain.org" },
  berachain: { chainId: 80094, defaultRpcUrl: "https://rpc.berachain.com" },
  soneium: { chainId: 1868, defaultRpcUrl: "https://rpc.soneium.org" },
  ronin: { chainId: 2020, defaultRpcUrl: "https://api.roninchain.com/rpc" },
  abstract: { chainId: 2741, defaultRpcUrl: "https://api.mainnet.abs.xyz" },
  b3: { chainId: 8333, defaultRpcUrl: "https://mainnet-rpc.b3.fun" },
  flow: { chainId: 747, defaultRpcUrl: "https://mainnet.evm.nodes.onflow.org" },

  // Testnets, for a dry run before the real thing.
  sepolia: { chainId: 11155111, defaultRpcUrl: "https://ethereum-sepolia-rpc.publicnode.com" },
  base_sepolia: { chainId: 84532, defaultRpcUrl: "https://base-sepolia-rpc.publicnode.com" },
};

/**
 * Pick the RPC URL to use. An explicit RPC_URL always wins.
 */
export function resolveRpcUrl(chain: string, envRpcUrl?: string | null): string {
  if (envRpcUrl && envRpcUrl.trim().length > 0) return envRpcUrl.trim();
  const info = CHAINS[chain];
  if (!info) {
    throw new Error(
      `No default RPC URL for chain "${chain}". Set RPC_URL in your environment, ` +
        `or use one of: ${Object.keys(CHAINS).join(", ")}`,
    );
  }
  return info.defaultRpcUrl;
}

/**
 * The name OpenSea's API uses for a chain, which is not always the name people
 * reach for: Polygon is `matic` there. Used when building api.opensea.io URLs.
 */
export function openseaChainSlug(chain: string): string {
  return CHAINS[chain]?.openseaSlug ?? chain;
}
