/**
 * Vercel entry point. `vercel.json` rewrites every path here, so /1234 and
 * /status both land in this function.
 *
 * Vercel has no R2, so use metadata.source "bundled" or "http" when deploying
 * here.
 */

import { config as dropConfig } from "../drop.config.ts";
import { envFromRecord } from "../src/env.ts";
import { handleRequest } from "../src/handler.ts";
import { createRuntime, type Runtime } from "../src/runtime.ts";

export const config = { runtime: "edge" };

let runtime: Runtime | null = null;
let initError: Error | null = null;

export default async function handler(request: Request): Promise<Response> {
  if (!runtime && !initError) {
    try {
      runtime = createRuntime({ config: dropConfig, env: envFromRecord(process.env) });
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
}
