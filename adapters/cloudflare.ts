/**
 * Cloudflare Workers entry point. `npx wrangler deploy` uses this.
 *
 * The runtime is built on the first request and reused, so a busy mint does not
 * re-read your config thousands of times. A configuration mistake surfaces as a
 * 500 with the exact problem in the body, rather than a worker that refuses to
 * start with nothing to look at.
 */

import { config } from "../drop.config.ts";
import type { Env } from "../src/env.ts";
import { handleRequest } from "../src/handler.ts";
import { createRuntime, type Runtime } from "../src/runtime.ts";

let runtime: Runtime | null = null;
let initError: Error | null = null;

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    if (!runtime && !initError) {
      try {
        runtime = createRuntime({ config, env });
      } catch (error) {
        initError = error instanceof Error ? error : new Error(String(error));
      }
    }

    if (initError) {
      return new Response(
        JSON.stringify({ error: "configuration problem", detail: initError.message }, null, 2) + "\n",
        {
          status: 500,
          headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
        },
      );
    }

    return handleRequest(request, runtime as Runtime);
  },
};
