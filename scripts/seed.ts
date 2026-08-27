/**
 * Manages the optional shuffle seed.
 *
 *   npm run seed:new     generate a seed and the commitment you publish
 *   npm run seed:show    show the commitment and a sample of the mapping
 *
 * The seed decides which artwork each token ID gets. Publish the commitment
 * before your mint opens, keep the seed secret until it closes, then publish the
 * seed so anyone can check the two agree.
 *
 * Losing the seed means you can never reveal. Keep a copy somewhere that is not
 * this laptop.
 */

import { config } from "../drop.config.ts";
import { MANIFEST, MANIFEST_HASH } from "../src/generated/manifest.ts";
import { buildPermutation, bytesToHex, seedCommitment } from "../src/shuffle.ts";
import { DIM, info, RESET, warn } from "./shared.ts";

try {
  process.loadEnvFile();
} catch {
  // No .env file.
}

const command = process.argv[2] ?? "show";

if (command === "new") {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  const seed = bytesToHex(bytes);
  const commitment = await seedCommitment(seed);

  console.log("\n  a new shuffle seed\n");
  console.log(`  seed        ${seed}`);
  console.log(`  commitment  ${commitment}`);
  console.log("");
  console.log("  next, in this order:");
  console.log("");
  console.log(`    1. put the seed in your environment, and nowhere else`);
  console.log(`         SHUFFLE_SEED=${seed}`);
  console.log(
    `       ${DIM}locally in .env, in production: npx wrangler secret put SHUFFLE_SEED${RESET}`,
  );
  console.log("");
  console.log("    2. put the commitment in drop.config.ts, and turn the shuffle on");
  console.log(`         shuffle: { enabled: true, commitment: "${commitment}" }`);
  console.log("");
  console.log("    3. publish the commitment and your manifest hash before minting opens,");
  console.log("       so holders can check the mapping afterwards");
  console.log("");
  console.log("    4. once minting is done, set PUBLISH_SEED=true to serve the seed at");
  console.log("       /provenance");
  console.log("");
  process.exit(0);
}

if (command !== "show") {
  console.error(`\n  unknown command "${command}". Use "new" or "show".\n`);
  process.exit(1);
}

const seed = process.env.SHUFFLE_SEED;
if (!seed) {
  console.error("\n  SHUFFLE_SEED is not set. Run `npm run seed:new` to make one.\n");
  process.exit(1);
}

const commitment = await seedCommitment(seed);
console.log("\n  shuffle\n");
console.log(`  commitment       ${commitment}`);
console.log(`  in drop.config   ${config.reveal.shuffle.commitment ?? "(not set)"}`);
console.log(`  manifest hash    ${MANIFEST_HASH || "(manifest not built)"}`);
console.log("");

if (config.reveal.shuffle.commitment && config.reveal.shuffle.commitment !== commitment) {
  warn("the commitment in drop.config.ts does not match this seed. One of them is wrong.");
  console.log("");
}
if (!config.reveal.shuffle.enabled) {
  info("shuffle.enabled is false in drop.config.ts, so this mapping is not in use");
  console.log("");
}

const permutation = await buildPermutation(seed, config.maxSupply);
const sample = Math.min(10, config.maxSupply);
console.log(`  the first ${sample} tokens map to:\n`);
for (let position = 0; position < sample; position++) {
  const tokenId = config.tokenIdStart + position;
  const index = permutation[position] as number;
  const entry = MANIFEST[index];
  const label = entry?.name ? ` ${DIM}${entry.name}${RESET}` : "";
  console.log(`    token ${String(tokenId).padStart(6)}  ->  metadata index ${index}${label}`);
}
console.log("");
