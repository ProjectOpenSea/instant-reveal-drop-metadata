/**
 * Plain Node entry point: `npm run dev`.
 *
 * Use it to try things locally, and to run a real test drop through a tunnel
 * without signing up for anything (see docs/test-run.md). It is also a fine way
 * to host the real thing if you already have somewhere to run a Node process.
 *
 * Every request is logged with the decision it produced, which makes a mint
 * pleasant to watch:
 *
 *   GET /41  200  unminted   1ms
 *   GET /41  200  minted     3ms      <- the mint landed
 */

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { config } from "../drop.config.ts";
import { ConfigError } from "../src/config.ts";
import { envFromRecord } from "../src/env.ts";
import { handleRequest } from "../src/handler.ts";
import { createRuntime, type Runtime, rpcHost } from "../src/runtime.ts";

// .env is optional. Node reads it natively, no dependency needed.
try {
  process.loadEnvFile();
} catch {
  // No .env file. Perfectly normal.
}

const port = Number(process.env.PORT ?? 8787);
const quiet = process.env.QUIET === "true";

/** Matches the webhook handler's own limit, applied before anything buffers. */
const MAX_REQUEST_BODY_BYTES = 2_000_000;

let runtime: Runtime;
try {
  runtime = createRuntime({ config, env: envFromRecord(process.env) });
} catch (error) {
  if (error instanceof ConfigError) {
    console.error(`\n${error.message}\n`);
    process.exit(1);
  }
  throw error;
}

const server = createServer((request, response) => {
  void serve(request, response);
});

server.listen(port, () => {
  const base = `http://localhost:${port}`;
  console.log("");
  console.log("  instant reveal metadata server");
  console.log(`  listening on          ${base}`);
  console.log(`  contract              ${runtime.config.contract} on ${runtime.config.chain}`);
  console.log(
    `  token ids             ${runtime.config.tokenIdStart} to ${runtime.config.tokenIdEnd}`,
  );
  console.log(
    `  reveal mode           ${runtime.revealAll ? "always (REVEAL_ALL is set)" : runtime.config.reveal.mode}`,
  );
  console.log(`  metadata source       ${runtime.source.describe()}`);
  console.log(`  rpc                   ${rpcHost(runtime.rpcUrl)}`);
  console.log("");
  console.log(`  try                   ${base}/${runtime.config.tokenIdStart}`);
  console.log(`  check the setup       ${base}/status`);
  console.log("");
  console.log("  to expose this to the internet with no account anywhere:");
  console.log(`    npx cloudflared tunnel --url ${base}`);
  console.log("");
});

async function serve(incoming: IncomingMessage, response: ServerResponse): Promise<void> {
  const startedAt = Date.now();
  const method = incoming.method ?? "GET";
  const path = incoming.url ?? "/";
  const url = new URL(path, `http://${incoming.headers.host ?? `localhost:${port}`}`);

  const headers = new Headers();
  for (const [key, value] of Object.entries(incoming.headers)) {
    if (typeof value === "string") headers.set(key, value);
    else if (Array.isArray(value)) headers.set(key, value.join(", "));
  }

  const hasBody = method !== "GET" && method !== "HEAD";
  let body: string | undefined;
  if (hasBody) {
    try {
      body = await readBody(incoming);
    } catch (error) {
      const tooLarge = error instanceof BodyTooLargeError;
      response.writeHead(tooLarge ? 413 : 400, {
        "content-type": "application/json; charset=utf-8",
        "cache-control": "no-store",
        connection: "close",
      });
      response.end(`${JSON.stringify({ error: tooLarge ? "body too large" : "bad request" })}\n`);
      // Now the answer is on its way, stop whatever is still arriving.
      incoming.destroy();
      if (!quiet) console.log(`  ${method} ${url.pathname}  ${tooLarge ? 413 : 400}`);
      return;
    }
  }

  let result: Response;
  try {
    result = await handleRequest(new Request(url, { method, headers, body }), runtime);
  } catch (error) {
    console.error("unhandled error", error);
    result = new Response(`${JSON.stringify({ error: "internal error" })}\n`, {
      status: 500,
      headers: { "content-type": "application/json", "cache-control": "no-store" },
    });
  }

  const text = await result.text();
  const outgoing: Record<string, string> = {};
  result.headers.forEach((value, key) => {
    outgoing[key] = value;
  });

  response.writeHead(result.status, outgoing);
  response.end(method === "HEAD" ? undefined : text);

  if (!quiet) {
    const state = result.headers.get("x-reveal-state") ?? "";
    console.log(
      `  ${method} ${url.pathname}  ${result.status}  ${state.padEnd(10)} ${Date.now() - startedAt}ms`,
    );
  }
}

class BodyTooLargeError extends Error {}

/**
 * Read a request body, and stop reading once it is clearly not one of ours.
 *
 * The webhook handler enforces its own limit, but it only sees the body after
 * something has already held all of it in memory. On Node that something is
 * this function, so the ceiling has to be here as well: without it a single
 * POST of arbitrary length is enough to exhaust a self-hosted process, and
 * `/webhook/mint` answers 404 on a server that never configured a webhook, so
 * the request does not even have to be plausible.
 */
function readBody(incoming: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;

    let over = false;

    incoming.on("data", (chunk: Buffer) => {
      if (over) return;
      size += chunk.length;
      if (size > MAX_REQUEST_BODY_BYTES) {
        // Stop reading, but leave the socket alive long enough to answer on it.
        // Destroying here instead would reach the client as a connection reset
        // with no status code, which is a worse thing to debug than a 413.
        over = true;
        incoming.pause();
        reject(new BodyTooLargeError(`body exceeds ${MAX_REQUEST_BODY_BYTES} bytes`));
        return;
      }
      chunks.push(chunk);
    });
    incoming.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    incoming.on("error", reject);
  });
}
