/**
 * This is the file you edit. Everything else is machinery.
 *
 * Nothing here is secret, so it is safe to commit. Secrets (your RPC URL, your
 * shuffle seed) live in the environment instead. See .env.example.
 */

import type { DropConfig } from "./src/config.ts";

export const config: DropConfig = {
  // Which chain your drop is on: ethereum, base, matic, arbitrum, optimism,
  // sei, ape_chain, and others. See src/chains.ts for the full list, or set
  // RPC_URL and use any chain you like.
  chain: "base",

  // Your drop contract. OpenSea Studio shows this on the drop's page, and it
  // is in the URL of the collection on opensea.io.
  contract: "0x0000000000000000000000000000000000000000",

  // The first token ID your contract mints. OpenSea Studio drops start at 1.
  tokenIdStart: 1,

  // How many tokens exist in total. This has to match maxSupply() on the
  // contract. `npm run preflight` checks that for you.
  maxSupply: 1000,

  reveal: {
    // "on-mint" is the point of this repository: each token becomes visible the
    // moment its mint lands onchain, and not a second before.
    //
    // "always" reveals everything immediately, which is the same as publishing
    // to IPFS up front. "never" keeps everything hidden, which is handy while
    // you are checking your placeholder looks right.
    mode: "on-mint",

    shuffle: {
      // Optional. Off means token 1 gets your first metadata file, token 2 the
      // second, and so on.
      //
      // On means the mapping is scrambled with a secret seed, and you publish a
      // commitment to that seed before the mint so holders can check afterwards
      // that you did not reshuffle to keep the good ones. Run `npm run seed:new`
      // and follow what it prints. Read docs/security.md first.
      enabled: false,
      commitment: null,
    },
  },

  mintState: {
    // "sequential" reads totalSupply() once and applies the answer to every
    // token, which works because SeaDrop mints IDs in order. Use "ownerOf" if
    // your contract can mint IDs out of order.
    mode: "sequential",

    // How long a "not minted yet" answer is trusted before we ask the chain
    // again. 10 seconds is roughly a block, and costs about 6 RPC calls a
    // minute no matter how much traffic you get.
    ttlSeconds: 10,

    // Blocks of margin before treating a mint as final. 0 is fine: a token's
    // artwork is fixed by its ID, so a reorg can only reveal one token a few
    // seconds early, never the wrong artwork. Raise it if you would rather be
    // slow than early.
    confirmations: 0,
  },

  metadata: {
    // "bundled" compiles your metadata into the deployment, which needs no
    // storage account anywhere. "r2" reads from a private Cloudflare R2 bucket.
    // "http" reads from a private URL you control.
    source: "bundled",

    // If your metadata files carry a relative image path like "images/17.png",
    // put the IPFS or HTTPS prefix here. Leave empty when your files already
    // contain full URIs, which is the normal case.
    imageBaseUri: "",
  },

  // What an unminted token looks like. {tokenId} is substituted anywhere in
  // these strings. Every token shows this until it mints.
  placeholder: {
    name: "Unrevealed #{tokenId}",
    description:
      "This one has not been minted yet. Artwork appears here the moment it is.",
    image: "ipfs://REPLACE_WITH_YOUR_PLACEHOLDER_IMAGE_CID",
    attributes: [],
  },

  // Optional collection level metadata, served at /contract.json. Only needed
  // if your contract's contractURI() points at this server.
  contractMetadata: null,
};

export default config;
