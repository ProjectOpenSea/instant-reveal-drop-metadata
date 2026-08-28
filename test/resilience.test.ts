/**
 * What happens when something other than the chain breaks.
 *
 * The rule everywhere here is the same one the rest of the server follows: a
 * failure costs a late reveal, never an early one, and never a broken token
 * record at a marketplace.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { handleRequest } from "../src/handler.ts";
import { createKvRevealStore } from "../src/reveal-store.ts";
import { get, makeBrokenStore, makeFakeKv, makeFlakyKv, makeRuntime } from "./helpers.ts";

describe("a metadata source that fails", () => {
  it("serves the placeholder rather than a 500", async () => {
    const { runtime } = makeRuntime({ chain: { totalSupply: 5, metadataDown: true } });

    const response = await handleRequest(get("/3"), runtime);
    const body = (await response.json()) as { name: string };

    assert.equal(response.status, 200);
    assert.equal(response.headers.get("x-reveal-state"), "error");
    assert.equal(body.name, "Unrevealed #3");
  });

  it("lets nothing cache that placeholder", async () => {
    const { runtime } = makeRuntime({ chain: { totalSupply: 5, metadataDown: true } });

    const response = await handleRequest(get("/3"), runtime);

    assert.equal(response.headers.get("cache-control"), "no-store");
  });

  it("reports the failure at /status", async () => {
    const { runtime } = makeRuntime({ chain: { totalSupply: 5, metadataDown: true } });
    await handleRequest(get("/3"), runtime);

    const status = (await (await handleRequest(get("/status"), runtime)).json()) as {
      mintState: { lastError: string | null };
    };

    assert.match(String(status.mintState.lastError), /502/);
  });

  it("recovers once the source comes back", async () => {
    const { runtime, chain } = makeRuntime({ chain: { totalSupply: 5, metadataDown: true } });
    await handleRequest(get("/3"), runtime);

    chain.metadataDown = false;
    const response = await handleRequest(get("/3"), runtime);
    const body = (await response.json()) as { name: string };

    assert.equal(body.name, "Artwork 2");
    assert.equal(response.headers.get("x-reveal-state"), "minted");
  });
});

describe("a burst of requests for one token", () => {
  it("makes one upstream metadata call, not one per request", async () => {
    // Every marketplace and wallet watching the contract asks the moment a
    // token reveals, and they all miss the empty cache together. Caching only
    // the settled value sends that whole first wave upstream in parallel.
    const { runtime, chain } = makeRuntime({ chain: { totalSupply: 5 } });

    const responses = await Promise.all(
      Array.from({ length: 50 }, () => handleRequest(get("/3"), runtime)),
    );

    assert.equal(chain.metadataCalls, 1, `made ${chain.metadataCalls} metadata calls`);
    for (const response of responses) {
      assert.equal(response.headers.get("x-reveal-state"), "minted");
    }
  });

  it("retries after a failure rather than caching it", async () => {
    // A bad gateway is a moment, not a fact about the index. Keeping the
    // rejected load would turn one blip into a permanent placeholder.
    const { runtime, chain } = makeRuntime({
      chain: { totalSupply: 5, metadataDown: true },
    });

    const first = await handleRequest(get("/3"), runtime);
    assert.equal(first.headers.get("x-reveal-state"), "error");

    chain.metadataDown = false;
    const second = await handleRequest(get("/3"), runtime);

    assert.equal(second.headers.get("x-reveal-state"), "minted");
  });

  it("retries a file that was not uploaded yet", async () => {
    // 404 means "nothing there right now", which is usually a file still being
    // uploaded. Caching it would keep the token on the placeholder after the
    // file appears.
    const { runtime, chain } = makeRuntime({
      chain: { totalSupply: 5, metadataMissing: [2] },
    });

    const first = await handleRequest(get("/3"), runtime);
    assert.equal(first.headers.get("x-reveal-state"), "metadata-missing");

    chain.metadataMissing = [];
    const second = await handleRequest(get("/3"), runtime);

    assert.equal(second.headers.get("x-reveal-state"), "minted");
  });
});

describe("a shared store that fails", () => {
  it("still reveals the token a webhook delivered", async () => {
    const { runtime } = makeRuntime({
      env: { WEBHOOK_SECRET: "s3cret" },
      store: makeBrokenStore(),
    });

    const webhook = await handleRequest(
      new Request("https://drop.test/webhook/mint", {
        method: "POST",
        headers: { authorization: "Bearer s3cret" },
        body: JSON.stringify({ tokenIds: [4] }),
      }),
      runtime,
    );

    assert.equal(webhook.status, 200, "a failed store write must not fail the delivery");

    const token = await handleRequest(get("/4"), runtime);
    assert.equal(token.headers.get("x-reveal-state"), "minted");
  });

  it("says so at /status", async () => {
    const { runtime } = makeRuntime({
      env: { WEBHOOK_SECRET: "s3cret" },
      store: makeBrokenStore(),
    });
    await handleRequest(
      new Request("https://drop.test/webhook/mint", {
        method: "POST",
        headers: { authorization: "Bearer s3cret" },
        body: JSON.stringify({ tokenIds: [4] }),
      }),
      runtime,
    );

    const status = (await (await handleRequest(get("/status"), runtime)).json()) as {
      mintState: { lastError: string | null };
    };

    assert.match(String(status.mintState.lastError), /reveal store write failed/);
  });
});

describe("the kv store", () => {
  it("coalesces a burst of bumps into one write", async () => {
    const kv = makeFakeKv();
    const store = createKvRevealStore(kv);

    for (let tokenId = 1; tokenId <= 50; tokenId++) await store.bumpHighWater(tokenId);

    assert.equal(kv.writes.length, 1, "Cloudflare KV allows about one write a second per key");
  });

  it("does not lose the highest value it was given", async () => {
    const kv = makeFakeKv();
    const store = createKvRevealStore(kv);

    for (let tokenId = 1; tokenId <= 50; tokenId++) await store.bumpHighWater(tokenId);
    assert.equal(await store.getHighWater(), 50);

    // The parked value lands on the next store call past the write window.
    await new Promise((resolve) => setTimeout(resolve, 1_050));
    await store.bumpHighWater(51);

    assert.equal(kv.writes.at(-1), "51");
    assert.equal(await store.getHighWater(), 51);
  });

  it("does not drop a value whose write failed", async () => {
    // The write window is consumed and `pending` cleared before the put, and
    // `bumpHighWater` returns early for anything at or below the local mark.
    // So without putting the value back, one failed write stops this instance
    // publishing its mark for the rest of the mint, and nothing says so.
    const kv = makeFlakyKv();
    const store = createKvRevealStore(kv);

    await assert.rejects(() => store.bumpHighWater(10));
    assert.deepEqual(kv.writes, [], "the write failed, so nothing landed");

    kv.failingWrites = false;
    await new Promise((resolve) => setTimeout(resolve, 1_050));
    await store.getHighWater();

    assert.deepEqual(kv.writes, ["10"], "the parked value is written once KV recovers");
  });

  it("keeps the newer value when a bump lands during a failed write", async () => {
    const kv = makeFlakyKv();
    const store = createKvRevealStore(kv);

    await assert.rejects(() => store.bumpHighWater(10));
    kv.failingWrites = false;
    await new Promise((resolve) => setTimeout(resolve, 1_050));
    await store.bumpHighWater(20);

    assert.deepEqual(kv.writes, ["20"], "20 supersedes the 10 that never landed");
    assert.equal(await store.getHighWater(), 20);
  });

  it("reveals the token anyway, because the local mark is what answers", async () => {
    const kv = makeFlakyKv();
    const store = createKvRevealStore(kv);

    await assert.rejects(() => store.bumpHighWater(10));

    assert.equal(await store.getHighWater(), 10);
  });

  it("never lowers the mark", async () => {
    const kv = makeFakeKv();
    const store = createKvRevealStore(kv);

    await store.bumpHighWater(40);
    await store.bumpHighWater(12);

    assert.equal(await store.getHighWater(), 40);
  });
});

describe("an rpc endpoint that fails mid-mint", () => {
  it("says rpc-unavailable rather than unminted", async () => {
    // ttlSeconds 0 so every request wants a fresh read, and the failure is
    // reached rather than answered from a cached one.
    const { runtime, chain } = makeRuntime({
      config: { mintState: { mode: "sequential", ttlSeconds: 0 } },
      chain: { totalSupply: 3 },
    });

    // One good read first, so the reader has a high water mark to fall back on.
    const revealed = await handleRequest(get("/2"), runtime);
    assert.equal(revealed.headers.get("x-reveal-state"), "minted");

    chain.down = true;
    const unknown = await handleRequest(get("/9"), runtime);

    assert.equal(unknown.headers.get("x-reveal-state"), "rpc-unavailable");
    assert.equal(
      unknown.headers.get("cache-control"),
      "public, max-age=0, s-maxage=0, must-revalidate",
    );
  });

  it("backs off instead of retrying on every request", async () => {
    const { runtime, chain } = makeRuntime({
      config: { mintState: { mode: "sequential", ttlSeconds: 0 } },
      chain: { totalSupply: 3 },
    });
    await handleRequest(get("/2"), runtime);

    chain.down = true;
    const before = chain.rpcCalls;
    for (let i = 0; i < 20; i++) await handleRequest(get("/9"), runtime);

    assert.ok(
      chain.rpcCalls - before <= 2,
      `expected the failed endpoint to be left alone, saw ${chain.rpcCalls - before} calls`,
    );
  });
});
