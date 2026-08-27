/**
 * Asks OpenSea to re-read metadata for a range of tokens.
 *
 *   OPENSEA_API_KEY=... npm run refresh -- --from 1 --to 100
 *
 * You should not normally need this. OpenSea reads `tokenURI` when it indexes a
 * mint, which for this setup is already the revealed metadata. It is here for
 * the two cases where you do:
 *
 *   1. a token was indexed while the placeholder was still being served, for
 *      example because you turned the server on after minting started
 *   2. you migrated to IPFS after mint-out and want the change picked up now
 *      rather than whenever OpenSea next looks
 *
 * Get a key at https://docs.opensea.io/reference/api-keys.
 */

import { config } from "../drop.config.ts";
import { arg, fail, info, ok } from "./shared.ts";

try {
  process.loadEnvFile();
} catch {
  // No .env file.
}

const apiKey = process.env["OPENSEA_API_KEY"];
if (!apiKey) {
  console.error("\n  set OPENSEA_API_KEY first. https://docs.opensea.io/reference/api-keys\n");
  process.exit(1);
}

const from = Number(arg("from", String(config.tokenIdStart)));
const to = Number(arg("to", String(config.tokenIdStart + config.maxSupply - 1)));
const delayMs = Number(arg("delay", "250"));

if (!Number.isInteger(from) || !Number.isInteger(to) || to < from) {
  console.error("\n  --from and --to must be integers, with --to at least --from\n");
  process.exit(1);
}

console.log(`\n  refreshing tokens ${from} to ${to} on ${config.chain}\n`);

let refreshed = 0;
let failed = 0;

for (let tokenId = from; tokenId <= to; tokenId++) {
  const url =
    `https://api.opensea.io/api/v2/chain/${config.chain}/contract/` +
    `${config.contract}/nfts/${tokenId}/refresh`;

  try {
    const response = await fetch(url, {
      method: "POST",
      headers: { "x-api-key": apiKey, accept: "application/json" },
    });
    if (response.ok) {
      refreshed += 1;
    } else {
      failed += 1;
      fail(`token ${tokenId}: HTTP ${response.status} ${await response.text()}`);
    }
  } catch (error) {
    failed += 1;
    fail(`token ${tokenId}: ${(error as Error).message}`);
  }

  if (tokenId % 25 === 0) info(`${tokenId - from + 1} of ${to - from + 1} done`);
  if (delayMs > 0 && tokenId < to) await new Promise((resolve) => setTimeout(resolve, delayMs));
}

console.log("");
ok(`queued ${refreshed} refreshes`);
if (failed > 0) fail(`${failed} failed`);
console.log("");
info("refreshes are queued, not instant. Give it a few minutes.");
console.log("");
