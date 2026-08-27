/**
 * Writes the final, revealed metadata to `out/`, ready to pin to IPFS once your
 * mint is over.
 *
 *   npm run export
 *   npm run export -- --dir metadata/example --out out
 *
 * Files are named after the token ID with no extension, which is what
 * `tokenURI` expects when your baseURI ends in a slash. After pinning, point
 * the contract at the CID and this server can be switched off:
 *
 *   cast send <contract> "setBaseURI(string)" "ipfs://<cid>/"
 *
 * The shuffle, if you use one, is applied here, so the exported files match
 * exactly what the server has been serving all along.
 */

import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { config } from "../drop.config.ts";
import { resolveConfig } from "../src/config.ts";
import { buildPermutation, manifestHash, seedCommitment } from "../src/shuffle.ts";
import { arg, formatBytes, hasFlag, info, loadMetadataDir, ok, warn } from "./shared.ts";

try {
  process.loadEnvFile();
} catch {
  // No .env file.
}

const resolved = resolveConfig(config);
const dir = arg("dir", "metadata") as string;
const outDir = arg("out", "out") as string;

const { entries } = loadMetadataDir(dir);
const hash = await manifestHash(entries);

console.log(`\n  exporting ${resolved.maxSupply} tokens from ${dir} to ${outDir}/\n`);

if (entries.length < resolved.maxSupply) {
  warn(`only ${entries.length} metadata entries for ${resolved.maxSupply} tokens`);
}

let permutation: number[] | null = null;
if (resolved.reveal.shuffle.enabled) {
  const seed = process.env.SHUFFLE_SEED;
  if (!seed) {
    console.error(
      "\n  shuffle is on but SHUFFLE_SEED is not set. Exporting without it would produce " +
        "the wrong artwork for every token.\n",
    );
    process.exit(1);
  }
  const commitment = await seedCommitment(seed);
  if (resolved.reveal.shuffle.commitment && commitment !== resolved.reveal.shuffle.commitment) {
    console.error(
      `\n  this seed does not match the commitment in drop.config.ts.\n` +
        `    seed produces  ${commitment}\n` +
        `    config says    ${resolved.reveal.shuffle.commitment}\n`,
    );
    process.exit(1);
  }
  permutation = await buildPermutation(seed, resolved.maxSupply);
  ok(`shuffle applied, commitment ${commitment}`);
}

if (hasFlag("clean")) rmSync(outDir, { recursive: true, force: true });
mkdirSync(outDir, { recursive: true });

const prefix = resolved.metadata.imageBaseUri
  ? resolved.metadata.imageBaseUri.endsWith("/")
    ? resolved.metadata.imageBaseUri
    : `${resolved.metadata.imageBaseUri}/`
  : "";

let written = 0;
let bytes = 0;
let missing = 0;

for (let position = 0; position < resolved.maxSupply; position++) {
  const tokenId = resolved.tokenIdStart + position;
  const index = permutation ? (permutation[position] as number) : position;
  const entry = entries[index];
  if (!entry) {
    missing += 1;
    continue;
  }

  const body: Record<string, unknown> = { ...entry };
  if (prefix) {
    for (const field of ["image", "image_url", "animation_url"] as const) {
      const value = body[field];
      if (typeof value === "string" && value.length > 0 && !/^[a-z][a-z0-9+.-]*:/i.test(value)) {
        body[field] = prefix + value.replace(/^\/+/, "");
      }
    }
  }

  const json = `${JSON.stringify(body, null, 2)}\n`;
  writeFileSync(join(outDir, String(tokenId)), json);
  written += 1;
  bytes += Buffer.byteLength(json);
}

writeFileSync(
  join(outDir, "provenance.json"),
  `${JSON.stringify(
    {
      contract: resolved.contract,
      chain: resolved.chain,
      tokenIdStart: resolved.tokenIdStart,
      maxSupply: resolved.maxSupply,
      manifestHash: hash,
      shuffle: resolved.reveal.shuffle.enabled
        ? {
            enabled: true,
            commitment: resolved.reveal.shuffle.commitment,
            // The seed is left out unless you ask for it, because this file is
            // about to be pinned publicly and forever.
            seed: hasFlag("include-seed") ? (process.env.SHUFFLE_SEED ?? null) : null,
          }
        : { enabled: false },
      exportedAt: new Date().toISOString(),
    },
    null,
    2,
  )}\n`,
);

ok(`wrote ${written} token files, ${formatBytes(bytes)} total`);
if (missing > 0) warn(`${missing} tokens had no metadata entry and were skipped`);
ok(`wrote ${outDir}/provenance.json`);

console.log("");
if (resolved.reveal.shuffle.enabled) {
  info(
    hasFlag("include-seed")
      ? "provenance.json contains your seed, and is about to be pinned publicly"
      : "provenance.json omits the seed. Pass --include-seed to publish it there too.",
  );
  console.log("");
}
console.log("  to pin and hand over:");
console.log("");
console.log(`    ipfs add -r --cid-version 1 ${outDir}`);
console.log(`    cast send ${resolved.contract} "setBaseURI(string)" "ipfs://<cid>/" \\`);
console.log(`      --rpc-url $RPC_URL --private-key $KEY`);
console.log("");
console.log("  check a token resolves through a gateway before you switch the server off.");
console.log("");
