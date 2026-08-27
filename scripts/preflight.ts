/**
 * Checks your setup against the live contract, and optionally against your
 * deployed server. Everything here is read-only.
 *
 *   npm run preflight
 *   npm run preflight -- --url https://my-drop.workers.dev
 *
 * Run it before you point your contract at the server, and again afterwards.
 */

import { config } from "../drop.config.ts";
import { resolveRpcUrl } from "../src/chains.ts";
import { resolveConfig } from "../src/config.ts";
import { MANIFEST } from "../src/generated/manifest.ts";
import {
  decodeAddress,
  decodeString,
  ERC721_INTERFACE_ID,
  encodeUint256,
  RevertError,
  RpcClient,
  readString,
  readSupportsInterface,
  readTokenExists,
  readTotalSupply,
  SELECTORS,
} from "../src/rpc.ts";
import { arg, DIM, fail, info, ok, RESET, warn } from "./shared.ts";

try {
  process.loadEnvFile();
} catch {
  // No .env file, which is fine if RPC_URL is already in the environment.
}

let failures = 0;
const bad = (message: string) => {
  failures += 1;
  fail(message);
};

const resolved = resolveConfig(config);
const rpcUrl = resolveRpcUrl(resolved.chain, process.env.RPC_URL);
const client = new RpcClient({ url: rpcUrl, timeoutMs: 10_000 });
const serverUrl = arg("url")?.replace(/\/+$/, "");

console.log(`\n  drop      ${resolved.contract} on ${resolved.chain}`);
console.log(`  rpc       ${new URL(rpcUrl).host}`);
if (!process.env.RPC_URL) {
  console.log(`  ${DIM}using a shared public endpoint, set RPC_URL for a real mint${RESET}`);
}
console.log("\n  contract\n");

let totalSupply = 0;

try {
  const block = await client.blockNumber();
  ok(`rpc reachable, at block ${block.toLocaleString("en-US")}`);
} catch (error) {
  bad(`rpc unreachable: ${(error as Error).message}`);
}

try {
  if (await readSupportsInterface(client, resolved.contract, ERC721_INTERFACE_ID)) {
    ok("contract reports ERC-721 support");
  } else {
    bad("contract does not report ERC-721 support. Is the address right, and on this chain?");
  }
} catch (error) {
  bad(`could not read the contract: ${(error as Error).message}`);
}

try {
  const name = await readString(client, resolved.contract, SELECTORS.name);
  const symbol = await readString(client, resolved.contract, SELECTORS.symbol);
  ok(`name and symbol: ${name} (${symbol})`);
} catch (error) {
  warn(`could not read name() and symbol(): ${describe(error)}`);
}

try {
  const maxSupply = Number(await client.call(resolved.contract, SELECTORS.maxSupply).then(BigInt));
  if (maxSupply === resolved.maxSupply) {
    ok(`maxSupply matches your config: ${maxSupply.toLocaleString("en-US")}`);
  } else {
    bad(
      `maxSupply onchain is ${maxSupply.toLocaleString("en-US")} but drop.config.ts says ` +
        `${resolved.maxSupply.toLocaleString("en-US")}. Fix the config, or tokens will 404.`,
    );
  }
} catch (error) {
  warn(
    error instanceof RevertError
      ? "contract has no maxSupply(), so the token range could not be cross-checked"
      : `maxSupply() could not be read: ${describe(error)}`,
  );
}

try {
  totalSupply = Number(await readTotalSupply(client, resolved.contract));
  ok(
    `totalSupply is ${totalSupply.toLocaleString("en-US")}, so tokens ` +
      `${resolved.tokenIdStart} to ${resolved.tokenIdStart + totalSupply - 1} are minted`,
  );
} catch (error) {
  bad(`totalSupply() failed, and "sequential" mint state needs it: ${(error as Error).message}`);
}

if (totalSupply > 0) {
  try {
    const exists = await readTokenExists(client, resolved.contract, resolved.tokenIdStart);
    if (exists) {
      ok(`token ${resolved.tokenIdStart} exists, so tokenIdStart looks right`);
    } else {
      bad(
        `token ${resolved.tokenIdStart} does not exist even though totalSupply is ${totalSupply}. ` +
          `tokenIdStart is probably wrong.`,
      );
    }
  } catch (error) {
    warn(`ownerOf(${resolved.tokenIdStart}) could not be read: ${(error as Error).message}`);
  }
}

let baseUri = "";
try {
  baseUri = await readString(client, resolved.contract, SELECTORS.baseURI);
  if (!baseUri) {
    warn("baseURI is empty, so tokenURI returns an empty string. Nothing is wired up yet.");
  } else if (!baseUri.endsWith("/")) {
    warn(
      `baseURI does not end in a slash: ${baseUri}\n` +
        `        Without the trailing slash the contract returns this same URI for every ` +
        `token, which is how a pre-reveal drop works. Add the slash when you go live.`,
    );
  } else {
    ok(`baseURI ends in a slash, so tokenURI appends the token ID: ${baseUri}`);
  }
} catch (error) {
  warn(
    error instanceof RevertError
      ? "contract has no baseURI() getter, so this could not be checked"
      : `baseURI() could not be read: ${describe(error)}`,
  );
}

if (serverUrl && baseUri) {
  const expected = `${serverUrl}/`;
  if (baseUri === expected) {
    ok("baseURI already points at your server");
  } else {
    info(`baseURI is ${baseUri}, and your server is ${expected}`);
    info(`when you are ready: cast send ${resolved.contract} "setBaseURI(string)" "${expected}"`);
  }
}

try {
  const owner = decodeAddress(await client.call(resolved.contract, SELECTORS.owner));
  info(`setBaseURI has to come from the owner: ${owner}`);
} catch {
  // Not every contract exposes owner().
}

if (totalSupply > 0) {
  try {
    const tokenUri = decodeString(
      await client.call(
        resolved.contract,
        encodeUint256(SELECTORS.tokenURI, resolved.tokenIdStart),
      ),
    );
    info(`tokenURI(${resolved.tokenIdStart}) is currently ${tokenUri || "(empty)"}`);
  } catch {
    warn(`tokenURI(${resolved.tokenIdStart}) reverted`);
  }
}

console.log("\n  metadata\n");

if (resolved.metadata.source === "bundled") {
  if (MANIFEST.length === 0) {
    bad("the bundled manifest is empty. Run `npm run build:manifest`.");
  } else if (MANIFEST.length !== resolved.maxSupply) {
    warn(`bundled manifest has ${MANIFEST.length} entries for ${resolved.maxSupply} tokens`);
  } else {
    ok(`bundled manifest has ${MANIFEST.length} entries`);
  }
} else {
  info(`metadata source is "${resolved.metadata.source}", checked at runtime via /status`);
}

if (resolved.reveal.shuffle.enabled) {
  if (!process.env.SHUFFLE_SEED) {
    warn("shuffle is on but SHUFFLE_SEED is not set here, so this check cannot verify the mapping");
  } else {
    ok("shuffle is on and SHUFFLE_SEED is set");
  }
  if (!resolved.reveal.shuffle.commitment) {
    bad("shuffle is on but no commitment is published in drop.config.ts");
  }
}

if (serverUrl) {
  console.log(`\n  server at ${serverUrl}\n`);
  await checkServer(serverUrl, totalSupply);
}

console.log("");
if (failures === 0) {
  console.log("  nothing blocking.\n");
} else {
  console.log(`  ${failures} problem${failures === 1 ? "" : "s"} to fix.\n`);
  process.exit(1);
}

/** A contract that does not have a getter is a different problem to a dead RPC. */
function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function checkServer(base: string, minted: number): Promise<void> {
  try {
    const status = await fetch(`${base}/status`);
    const body = (await status.json()) as { ok?: boolean; problems?: string[] };
    if (body.ok) {
      ok("/status reports no problems");
    } else {
      for (const problem of body.problems ?? ["unknown problem"]) bad(`/status: ${problem}`);
    }
  } catch (error) {
    bad(`could not reach ${base}/status: ${(error as Error).message}`);
    return;
  }

  // A token that is definitely minted should be revealed and cacheable forever.
  if (minted > 0) {
    const tokenId = resolved.tokenIdStart + minted - 1;
    const response = await tryFetch(`${base}/${tokenId}`);
    if (!response) return;
    const cacheControl = response.headers.get("cache-control") ?? "";
    const state = response.headers.get("x-reveal-state") ?? "";
    if (state === "minted" || state === "reveal-all") {
      ok(`token ${tokenId} is revealed (x-reveal-state: ${state})`);
    } else {
      bad(`token ${tokenId} is minted onchain but the server says "${state}"`);
    }
    if (/immutable/.test(cacheControl)) {
      ok(`revealed tokens are cacheable: ${cacheControl}`);
    } else {
      warn(`revealed token cache-control looks wrong: ${cacheControl}`);
    }
    if (response.headers.get("access-control-allow-origin") === "*") {
      ok("CORS is open, so browser clients can read the metadata");
    } else {
      warn("no access-control-allow-origin header");
    }
  }

  // A token that is definitely not minted must be a placeholder, and must not
  // be cached by anything.
  const unmintedId = resolved.tokenIdStart + minted;
  if (unmintedId <= resolved.tokenIdEnd) {
    const response = await tryFetch(`${base}/${unmintedId}`);
    if (!response) return;
    const cacheControl = response.headers.get("cache-control") ?? "";
    const state = response.headers.get("x-reveal-state") ?? "";
    if (state === "unminted") {
      ok(`token ${unmintedId} is not minted and is being withheld`);
    } else if (state === "reveal-all") {
      warn(`token ${unmintedId} is not minted but reveal mode is "always", so it is public`);
    } else {
      bad(`token ${unmintedId} is not minted but the server said "${state}"`);
    }
    if (/max-age=0|no-store|no-cache/.test(cacheControl)) {
      ok(`unrevealed tokens are not cacheable: ${cacheControl}`);
    } else {
      bad(
        `unrevealed token cache-control is ${cacheControl}, so a CDN may keep serving the ` +
          `placeholder after the token mints`,
      );
    }
  } else {
    info("the drop is fully minted, so there is no unminted token to test against");
  }

  const outOfRange = await tryFetch(`${base}/${resolved.tokenIdEnd + 1}`);
  if (!outOfRange) return;
  if (outOfRange.status === 404) {
    ok(`token ${resolved.tokenIdEnd + 1} is outside the drop and 404s`);
  } else {
    warn(`token ${resolved.tokenIdEnd + 1} returned ${outOfRange.status}, expected 404`);
  }
}

async function tryFetch(url: string): Promise<Response | null> {
  try {
    return await fetch(url);
  } catch (error) {
    bad(`could not reach ${url}: ${(error as Error).message}`);
    return null;
  }
}
