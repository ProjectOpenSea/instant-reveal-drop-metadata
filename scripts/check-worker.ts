/**
 * Checks that the server still bundles as a Cloudflare Worker.
 *
 *   npm run check:worker
 *
 * Everything in `test/` runs on Node, so nothing else notices when shared code
 * under `src/` picks up something Workers cannot provide. A `node:fs` import
 * added to `src/handler.ts` passes typecheck and every test, and then fails at
 * runtime on the deploy target the README recommends.
 *
 * `wrangler deploy --dry-run` needs no credentials, but it reports that problem
 * as a warning and still exits 0, so this reads its output and decides.
 */

import { spawnSync } from "node:child_process";
import { GREEN, RED, RESET } from "./shared.ts";

/**
 * Warnings that say nothing about the bundle. Wrangler mentions a proxy
 * whenever HTTPS_PROXY is set, which is true on plenty of corporate networks
 * and CI runners, so failing on it would be noise rather than signal.
 */
const BENIGN = [/Proxy environment variables detected/i];

const result = spawnSync(
  "npx",
  ["--yes", "wrangler@4", "deploy", "--dry-run", "--outdir", "node_modules/.worker-check"],
  { encoding: "utf8", env: { ...process.env, WRANGLER_SEND_METRICS: "false" } },
);

const output = `${result.stdout ?? ""}${result.stderr ?? ""}`;
process.stdout.write(output);

if (result.error) {
  console.error(`\n  ${RED}fail${RESET}  could not run wrangler: ${result.error.message}\n`);
  process.exit(1);
}
if (result.status !== 0) {
  console.error(`\n  ${RED}fail${RESET}  wrangler exited ${result.status}\n`);
  process.exit(1);
}

// Wrangler colours its output, so the word WARNING sits against an escape
// sequence and never starts on a word boundary. Strip the escapes first.
const plain = output.replace(/\[[0-9;]*m/g, "");
const warnings = plain
  .split("\n")
  .filter((line) => line.includes("[WARNING]"))
  .filter((line) => !BENIGN.some((pattern) => pattern.test(line)));

if (warnings.length > 0) {
  console.error(
    `\n  ${RED}fail${RESET}  wrangler warned about the bundle, so the worker may break at\n` +
      `        runtime. A "built into node" warning means something under src/ imported a\n` +
      `        Node API. src/ has to run on Workers, Vercel edge, and Node, so keep Node\n` +
      `        APIs in adapters/ and scripts/.\n`,
  );
  process.exit(1);
}

const size = /Total Upload: (.+)$/m.exec(plain)?.[1]?.trim();
console.log(`\n  ${GREEN}ok${RESET}  the worker bundles${size ? `, ${size}` : ""}\n`);
