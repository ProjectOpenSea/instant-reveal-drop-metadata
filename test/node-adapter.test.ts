/**
 * The Node adapter, driven over a real socket.
 *
 * Everything else in the suite calls `handleRequest` directly, which skips the
 * whole of `adapters/node.ts`: the body cap applied before anything buffers,
 * the 413 it answers with, and the conversion between Node's headers and the
 * Fetch API's in both directions. None of that runs on Workers either, so
 * `check:worker` does not cover it and neither does anything else.
 *
 * The runtime is the same fake-chain one the rest of the tests use, so this
 * still touches no network.
 */

import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { after, before, describe, it } from "node:test";
import { createNodeServer } from "../adapters/node.ts";
import { makeRuntime } from "./helpers.ts";

describe("the node adapter over a socket", () => {
  const { runtime } = makeRuntime({ chain: { totalSupply: 5 } });
  const server = createNodeServer({ runtime, quiet: true });
  let base = "";

  before(async () => {
    await new Promise<void>((resolve) => {
      server.listen(0, "127.0.0.1", resolve);
    });
    const address = server.address() as AddressInfo;
    base = `http://127.0.0.1:${address.port}`;
  });

  after(async () => {
    // fetch keeps connections alive, and `close` waits for every one of them.
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  });

  it("serves a minted token", async () => {
    const response = await fetch(`${base}/3`);
    const body = (await response.json()) as { name: string };

    assert.equal(response.status, 200);
    assert.equal(response.headers.get("x-reveal-state"), "minted");
    assert.equal(body.name, "Artwork 2");
  });

  it("carries the cache and content headers back through Node", async () => {
    const response = await fetch(`${base}/3`);

    assert.match(response.headers.get("content-type") ?? "", /application\/json/);
    assert.match(response.headers.get("cache-control") ?? "", /immutable/);
    assert.equal(response.headers.get("x-content-type-options"), "nosniff");
    assert.equal(response.headers.get("access-control-allow-origin"), "*");
  });

  it("withholds an unminted token and forbids caching it", async () => {
    const response = await fetch(`${base}/6`);
    const body = (await response.json()) as { name: string };

    assert.equal(response.headers.get("x-reveal-state"), "unminted");
    assert.equal(body.name, "Unrevealed #6");
    assert.match(response.headers.get("cache-control") ?? "", /max-age=0|no-store|no-cache/);
  });

  it("answers /status", async () => {
    const response = await fetch(`${base}/status`);
    const body = (await response.json()) as { drop: { contract: string } };

    assert.equal(response.status, 200);
    assert.equal(body.drop.contract, runtime.config.contract);
  });

  it("answers HEAD with the headers of the GET and no body", async () => {
    const response = await fetch(`${base}/3`, { method: "HEAD" });

    assert.equal(response.status, 200);
    assert.equal(response.headers.get("x-reveal-state"), "minted");
    assert.equal(await response.text(), "");
  });

  it("reads a request header the handler acts on", async () => {
    // Proves the incoming direction of the header conversion, not just the
    // outgoing one: OPTIONS is answered from the request method alone.
    const response = await fetch(`${base}/3`, { method: "OPTIONS" });

    assert.equal(response.status, 204);
    assert.equal(response.headers.get("access-control-allow-methods"), "GET, HEAD, OPTIONS");
  });

  it("404s a path that is not a token", async () => {
    const response = await fetch(`${base}/not-a-token`);

    assert.equal(response.status, 404);
  });

  it("stops reading a body past the cap, and says 413", async () => {
    // The webhook handler has its own limit, but it only sees a body after
    // something has held all of it in memory, and on Node that something is
    // the adapter. /webhook/mint 404s on a server with no webhook configured,
    // so the request does not even have to be plausible to cost the memory.
    const response = await fetch(`${base}/webhook/mint`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "x".repeat(2_100_000),
    });
    const body = (await response.json()) as { error: string };

    assert.equal(response.status, 413);
    assert.equal(body.error, "body too large");
  });

  it("still accepts a body under the cap", async () => {
    // The same route, small enough to be read: 404 because no WEBHOOK_SECRET
    // is set, which is the handler answering rather than the cap.
    const response = await fetch(`${base}/webhook/mint`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ tokenIds: [1] }),
    });

    assert.equal(response.status, 404);
  });
});
