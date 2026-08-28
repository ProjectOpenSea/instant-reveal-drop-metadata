/**
 * Helpers the scripts share. Nothing here runs in the server.
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import type { TokenMetadata } from "../src/config.ts";

export const GREEN = "\u001b[32m";
export const YELLOW = "\u001b[33m";
export const RED = "\u001b[31m";
export const DIM = "\u001b[2m";
export const RESET = "\u001b[0m";

export function ok(message: string): void {
  console.log(`  ${GREEN}ok${RESET}    ${message}`);
}
export function warn(message: string): void {
  console.log(`  ${YELLOW}warn${RESET}  ${message}`);
}
export function fail(message: string): void {
  console.log(`  ${RED}fail${RESET}  ${message}`);
}
export function info(message: string): void {
  console.log(`  ${DIM}note${RESET}  ${message}`);
}

/** Read `--flag value` style arguments. */
export function arg(name: string, fallback?: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`);
  if (index === -1 || index === process.argv.length - 1) return fallback;
  return process.argv[index + 1];
}

export function hasFlag(name: string): boolean {
  return process.argv.includes(`--${name}`);
}

export type LoadedMetadata = {
  entries: TokenMetadata[];
  /** Where each entry came from, for error messages. */
  files: string[];
};

/** The order of a metadata set could not be trusted to mean what you meant. */
export class MetadataOrderError extends Error {}

const LEADING_NUMBER = /^(\d+)/;

/**
 * Decide which file is which position, and refuse to guess.
 *
 * Position is what a token ID maps to, so getting this wrong is a whole
 * collection with the wrong artwork, and it cannot be corrected once the tokens
 * are minted. Every ambiguous case is an error rather than a best effort,
 * because the alternative is a build that prints "ok" and ships the wrong art.
 *
 * `dir` is only used to write a message someone can act on.
 */
export function orderMetadataFiles(names: readonly string[], dir: string): string[] {
  const numbered: Array<{ name: string; position: number }> = [];
  const unnumbered: string[] = [];

  for (const name of names) {
    const match = LEADING_NUMBER.exec(name);
    if (match?.[1]) numbered.push({ name, position: Number(match[1]) });
    else unnumbered.push(name);
  }

  if (unnumbered.length > 0) {
    throw new MetadataOrderError(
      `${dir} has files that are not named by position: ${list(unnumbered)}.\n` +
        `  Position decides which token gets which artwork, and a name like ` +
        `"art-10.json" sorts before "art-2.json", so the order would not be the ` +
        `one you meant.\n` +
        `  Either name every file for its position (1.json, 2.json, ...), or put ` +
        `the set in a single manifest.json array where the order is explicit.`,
    );
  }

  const byPosition = new Map<number, string[]>();
  for (const { name, position } of numbered) {
    const existing = byPosition.get(position);
    if (existing) existing.push(name);
    else byPosition.set(position, [name]);
  }

  const collisions = [...byPosition.values()].filter((group) => group.length > 1);
  if (collisions.length > 0) {
    throw new MetadataOrderError(
      `${dir} has more than one file for the same position: ` +
        `${collisions.map((group) => list(group.sort())).join("; ")}.\n` +
        `  A leftover draft or backup shifts every token after it onto the wrong ` +
        `artwork, so remove the extra file rather than letting the build pick one.`,
    );
  }

  const positions = [...byPosition.keys()].sort((a, b) => a - b);

  // Where the set starts is the other half of what position means, and it is
  // the half nothing else here checks. A set named 5.json through 1004.json has
  // no gaps, no duplicates, and exactly maxSupply entries, so every other guard
  // passes while the first token quietly gets 5.json and the whole collection
  // shifts by four. Only 0-based and 1-based sets are unambiguous.
  const lowest = positions[0] as number;
  if (lowest !== 0 && lowest !== 1) {
    throw new MetadataOrderError(
      `${dir} starts at ${lowest}, and a metadata set has to start at 0 or 1.\n` +
        `  Position decides which token gets which artwork, so this set would put ` +
        `${lowest}.json on the first token and shift every token after it.\n` +
        `  Renumber the set from 0 or from 1, or put it in a single manifest.json array ` +
        `where the order is explicit rather than inferred from the names.`,
    );
  }

  const missing: number[] = [];
  for (let i = 1; i < positions.length; i++) {
    const previous = positions[i - 1] as number;
    const current = positions[i] as number;
    for (let gap = previous + 1; gap < current && missing.length <= 10; gap++) missing.push(gap);
  }
  if (missing.length > 0) {
    const shown = missing.slice(0, 10).join(", ");
    throw new MetadataOrderError(
      `${dir} is missing ${shown}${missing.length > 10 ? ", ..." : ""}.\n` +
        `  A gap shifts every file after it onto the wrong token, so add the ` +
        `missing files or renumber the set so it runs without one.`,
    );
  }

  return positions.map((position) => (byPosition.get(position) as string[])[0] as string);
}

function list(names: readonly string[]): string {
  const shown = names.slice(0, 5).join(", ");
  return names.length > 5 ? `${shown}, and ${names.length - 5} more` : shown;
}

/**
 * Load a metadata set from a directory.
 *
 * Two layouts work. Either one JSON file per token (`1.json`, `2.json`, ...),
 * read in position order, or a single `manifest.json` holding an array. Position
 * in that order is what the token ID maps to, so it has to stay stable: if you
 * rename files between builds, tokens change artwork.
 */
export function loadMetadataDir(dir: string): LoadedMetadata {
  const single = join(dir, "manifest.json");
  if (existsFile(single)) {
    const parsed = JSON.parse(readFileSync(single, "utf8")) as unknown;
    if (!Array.isArray(parsed)) {
      throw new Error(`${single} must contain a JSON array of metadata objects`);
    }
    return { entries: parsed as TokenMetadata[], files: [single] };
  }

  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    throw new Error(`Cannot read ${dir}. Put your metadata JSON files there, or pass --dir.`);
  }

  // Skip dotfiles. macOS leaves AppleDouble copies like "._1.json" next to the
  // real files when a set is copied off a non-Mac drive, they are invisible in
  // Finder, and they are never metadata.
  const jsonFiles = names.filter(
    (name) => !name.startsWith(".") && name.toLowerCase().endsWith(".json"),
  );
  if (jsonFiles.length === 0) {
    throw new Error(
      `No .json files in ${dir}. Expected one file per token (1.json, 2.json, ...) or a single manifest.json.`,
    );
  }

  const ordered = orderMetadataFiles(jsonFiles, dir);

  const entries: TokenMetadata[] = [];
  const files: string[] = [];
  for (const name of ordered) {
    const path = join(dir, name);
    try {
      entries.push(JSON.parse(readFileSync(path, "utf8")) as TokenMetadata);
      files.push(path);
    } catch (error) {
      throw new Error(`${path} is not valid JSON: ${(error as Error).message}`);
    }
  }
  return { entries, files };
}

function existsFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

/**
 * Report a problem the way the rest of these scripts do, and stop. A metadata
 * set that cannot be ordered is a mistake to fix, not a stack trace to read.
 */
export function die(error: unknown): never {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`\n  ${RED}stop${RESET}  ${message}\n`);
  process.exit(1);
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

/**
 * The text of `src/generated/manifest.ts`.
 *
 * This lives next to `manifestEntryCount`, which reads it back, because the two
 * are one contract: `npm run check:privacy` decides whether your unrevealed
 * metadata is about to enter git history by parsing this exact shape out of
 * whatever git is holding. Change the shape here without changing the reader
 * and the check keeps passing while it has stopped looking at anything, which
 * is the worst way for a safety net to fail. Same file, same test.
 */
export function renderManifestModule(
  entries: readonly TokenMetadata[],
  hash: string,
  builtAt: string,
  sourceDir: string,
): string {
  return `/**
 * Generated by \`npm run build:manifest\`. Do not edit by hand.
 *
 * This file contains the artwork nobody is supposed to see yet. Keep your copy
 * of this repository private, or switch metadata.source to "r2" so the metadata
 * never touches git.
 *
 * Source directory: ${sourceDir}
 * Entries: ${entries.length}
 */

import type { TokenMetadata } from "../config.ts";

export const MANIFEST: TokenMetadata[] = ${JSON.stringify(entries, null, 2)};

/** SHA-256 over the manifest, published as part of your provenance record. */
export const MANIFEST_HASH: string = ${JSON.stringify(hash)};

/** When \`npm run build:manifest\` last ran. */
export const MANIFEST_BUILT_AT: string = ${JSON.stringify(builtAt)};
`;
}

const MANIFEST_ARRAY = /export const MANIFEST: TokenMetadata\[\] = (\[[\s\S]*?\]);\n/;

/**
 * How many metadata entries a generated manifest module declares.
 *
 * Returns -1 when the module is there but cannot be read, which is not the same
 * as empty: the caller stops rather than guessing, because guessing "empty"
 * would wave through the one commit this whole check exists to block.
 */
export function manifestEntryCount(source: string): number {
  const match = MANIFEST_ARRAY.exec(source);
  if (!match?.[1]) return 0;
  try {
    return (JSON.parse(match[1]) as unknown[]).length;
  } catch {
    return -1;
  }
}
