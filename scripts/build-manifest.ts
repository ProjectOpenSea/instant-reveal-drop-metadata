/**
 * Compiles your metadata files into the deployment.
 *
 *   npm run build:manifest
 *   npm run build:manifest -- --dir metadata/example
 *
 * Reads every JSON file in `metadata/` (or a single `metadata/manifest.json`
 * array), writes `src/generated/manifest.ts`, and prints the hash you publish
 * as part of your provenance record.
 *
 * Run it again any time your metadata changes, and redeploy afterwards.
 */

import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { gzipSync } from "node:zlib";
import { config } from "../drop.config.ts";
import { canonicalJson, manifestHash } from "../src/shuffle.ts";
import {
  arg,
  die,
  fail,
  formatBytes,
  info,
  loadMetadataDir,
  ok,
  renderManifestModule,
  warn,
} from "./shared.ts";

const OUTPUT = "src/generated/manifest.ts";
// Cloudflare's compressed worker size limit is 3 MB on the free plan.
const FREE_PLAN_LIMIT = 3 * 1024 * 1024;

const dir = arg("dir", "metadata") as string;

console.log(`\n  building a manifest from ${dir}\n`);

const { entries, files } = loadMetadataSet(dir);
const hash = await manifestHash(entries);

if (entries.length !== config.maxSupply) {
  warn(
    `${entries.length} metadata entries but maxSupply is ${config.maxSupply}. ` +
      `Tokens without an entry stay on the placeholder forever.`,
  );
} else {
  ok(`${entries.length} entries, matching maxSupply`);
}

const missingImages = entries.filter((entry) => !entry.image && !entry.image_url).length;
if (missingImages > 0) {
  warn(`${missingImages} entries have no image or image_url field`);
} else {
  ok("every entry has an image");
}

const missingNames = entries.filter((entry) => !entry.name).length;
if (missingNames > 0) warn(`${missingNames} entries have no name field`);

const body = renderManifestModule(entries, hash, new Date().toISOString(), dir);

mkdirSync(dirname(OUTPUT), { recursive: true });
writeFileSync(OUTPUT, body);

const rawBytes = Buffer.byteLength(canonicalJson(entries));
const gzipBytes = gzipSync(Buffer.from(body)).length;

ok(`wrote ${OUTPUT}`);
info(`metadata JSON  ${formatBytes(rawBytes)}`);
info(`compressed     ${formatBytes(gzipBytes)} (what counts against a Workers bundle limit)`);
info(`manifest hash  ${hash}`);

if (gzipBytes > FREE_PLAN_LIMIT) {
  fail(
    `too large to bundle on the Cloudflare free plan (${formatBytes(gzipBytes)} compressed). ` +
      `Switch metadata.source to "r2", or deploy somewhere without a bundle limit. ` +
      `See docs/large-drops.md.`,
  );
} else if (gzipBytes > FREE_PLAN_LIMIT * 0.7) {
  warn(
    `close to the Cloudflare free plan bundle limit (${formatBytes(gzipBytes)} of ` +
      `${formatBytes(FREE_PLAN_LIMIT)} compressed). See docs/large-drops.md.`,
  );
}

installPreCommitHook();

console.log("");
// Say out loud which file became which position. The order is the one thing
// here that cannot be corrected after a mint, so it is worth a glance.
const first = files[0];
const last = files.at(-1);
if (first && last && files.length > 1) {
  const lastTokenId = config.tokenIdStart + entries.length - 1;
  info(
    config.reveal.shuffle.enabled
      ? `the set runs ${basename(first)} to ${basename(last)}; the seed decides which token gets which`
      : `${basename(first)} is token ${config.tokenIdStart}, ${basename(last)} is token ${lastTokenId}`,
  );
}
if (config.reveal.shuffle.enabled) {
  info("shuffle is on, so publish this manifest hash and your seed commitment before minting");
}
console.log("");

/**
 * This file now holds the artwork nobody is supposed to see yet, and the most
 * common way it leaks is a `git add -A` into a public fork. Leave a pre-commit
 * hook behind that refuses that commit. Never overwrites a hook you already
 * have, and `git commit --no-verify` still bypasses it.
 */
function installPreCommitHook(): void {
  // Ask git where hooks live rather than assuming .git/hooks, which is wrong in
  // a worktree and wrong again when core.hooksPath is set.
  const hooksDir =
    git(["config", "--get", "core.hooksPath"]) ?? git(["rev-parse", "--git-path", "hooks"]);
  if (!hooksDir || !existsSync(hooksDir)) return;

  const hook = join(hooksDir, "pre-commit");
  if (existsSync(hook)) return;

  writeFileSync(
    hook,
    `#!/bin/sh
# Installed by \`npm run build:manifest\`. Blocks a commit that would put your
# unrevealed metadata into git history. See scripts/check-privacy.ts.
exec node scripts/check-privacy.ts
`,
  );
  chmodSync(hook, 0o755);
  info(`installed ${hook}, so a commit cannot leak your metadata`);
}

function git(args: string[]): string | null {
  try {
    return (
      execFileSync("git", args, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim() ||
      null
    );
  } catch {
    return null;
  }
}

/** Load the set, or print what is wrong with it and stop. */
function loadMetadataSet(from: string) {
  try {
    return loadMetadataDir(from);
  } catch (error) {
    die(error);
  }
}
