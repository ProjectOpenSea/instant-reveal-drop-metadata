/**
 * Refuses to let your unrevealed metadata reach a git commit.
 *
 *   npm run check:privacy
 *
 * `metadata/` is gitignored, but `npm run build:manifest` copies the same data
 * into `src/generated/manifest.ts`, which cannot be ignored because the
 * deployment needs it. Push that to a public repository and the mapping this
 * server exists to withhold is public, permanently, before your mint opens.
 *
 * So this checks what git is actually tracking rather than what is on disk. It
 * runs in CI, and `npm run build:manifest` installs it as a pre-commit hook so
 * the check happens before the commit rather than after the push.
 *
 * If your repository is private and you want the metadata in it, set
 * ALLOW_METADATA_IN_GIT=1.
 */

import { execFileSync } from "node:child_process";
import { GREEN, manifestEntryCount, RED, RESET } from "./shared.ts";

const MANIFEST = "src/generated/manifest.ts";

if (process.env.ALLOW_METADATA_IN_GIT === "1") {
  console.log(`\n  ${GREEN}skipped${RESET}  ALLOW_METADATA_IN_GIT=1 is set\n`);
  process.exit(0);
}

/** What git holds for a path, or null if git cannot answer. */
function gitShow(ref: string): string | null {
  try {
    return execFileSync("git", ["show", ref], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
  } catch {
    return null;
  }
}

const staged = gitShow(`:${MANIFEST}`);
const committed = gitShow(`HEAD:${MANIFEST}`);

const problems: string[] = [];
for (const [where, source] of [
  ["staged for commit", staged],
  ["already committed", committed],
] as const) {
  if (source === null) continue;
  const count = manifestEntryCount(source);
  if (count !== 0) {
    problems.push(
      count < 0
        ? `${MANIFEST} is ${where} and could not be read as empty`
        : `${MANIFEST} is ${where} with ${count} metadata entries`,
    );
  }
}

if (problems.length === 0) {
  console.log(`\n  ${GREEN}ok${RESET}  no unrevealed metadata in git\n`);
  process.exit(0);
}

console.error(`\n  ${RED}stop${RESET}  your unrevealed metadata is about to enter git history\n`);
for (const problem of problems) console.error(`    ${problem}`);
console.error(`
  Anyone who can read this repository can then read which artwork every token
  ID gets, before it mints. That is the one thing this server exists to prevent,
  and a git history cannot be un-published.

  Pick one:

    git rm --cached ${MANIFEST} && git checkout ${MANIFEST}
        keep the manifest out of git, and build it on the deploy machine

    metadata.source: "r2"  in drop.config.ts
        read metadata from a private bucket, so it never enters git at all

    ALLOW_METADATA_IN_GIT=1
        you are certain this repository is private and will stay private
`);
process.exit(1);
