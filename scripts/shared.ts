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

/**
 * Load a metadata set from a directory.
 *
 * Two layouts work. Either one JSON file per token (`1.json`, `2.json`, ...),
 * read in numeric order, or a single `manifest.json` holding an array. Position
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

  const jsonFiles = names.filter((name) => name.toLowerCase().endsWith(".json"));
  if (jsonFiles.length === 0) {
    throw new Error(
      `No .json files in ${dir}. Expected one file per token (1.json, 2.json, ...) or a single manifest.json.`,
    );
  }

  jsonFiles.sort(numericThenAlpha);

  const entries: TokenMetadata[] = [];
  const files: string[] = [];
  for (const name of jsonFiles) {
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

/** 2.json before 10.json, which a plain string sort gets wrong. */
function numericThenAlpha(a: string, b: string): number {
  const numA = Number.parseInt(a, 10);
  const numB = Number.parseInt(b, 10);
  const aIsNum = Number.isFinite(numA) && /^\d/.test(a);
  const bIsNum = Number.isFinite(numB) && /^\d/.test(b);
  if (aIsNum && bIsNum && numA !== numB) return numA - numB;
  if (aIsNum && !bIsNum) return -1;
  if (!aIsNum && bIsNum) return 1;
  return a.localeCompare(b);
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}
