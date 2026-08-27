import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { handleRequest } from "../src/handler.ts";
import { get, makeRuntime } from "./helpers.ts";

describe("serving a token", () => {
  it("withholds a token that has not minted", async () => {
    const { runtime } = makeRuntime({ chain: { totalSupply: 3 } });

    const response = await handleRequest(get("/4"), runtime);
    const body = (await response.json()) as { name: string };

    assert.equal(response.status, 200);
    assert.equal(response.headers.get("x-reveal-state"), "unminted");
    assert.equal(body.name, "Unrevealed #4");
  });

  it("reveals a token that has minted", async () => {
    const { runtime } = makeRuntime({ chain: { totalSupply: 3 } });

    const response = await handleRequest(get("/3"), runtime);
    const body = (await response.json()) as { name: string; image: string };

    assert.equal(response.headers.get("x-reveal-state"), "minted");
    assert.equal(body.name, "Artwork 2", "token 3 is position 2 of the set");
    assert.equal(body.image, "ipfs://art/2.png");
  });

  it("reveals a token as soon as the next poll sees the mint", async () => {
    const { runtime, chain } = makeRuntime({
      chain: { totalSupply: 3 },
      config: { mintState: { mode: "sequential", ttlSeconds: 0 } },
    });

    assert.equal((await handleRequest(get("/4"), runtime)).headers.get("x-reveal-state"), "unminted");

    chain.totalSupply = 4;

    assert.equal((await handleRequest(get("/4"), runtime)).headers.get("x-reveal-state"), "minted");
  });

  it("accepts a .json suffix, because some tools add one", async () => {
    const { runtime } = makeRuntime({ chain: { totalSupply: 5 } });

    const plain = (await (await handleRequest(get("/2"), runtime)).json()) as { name: string };
    const suffixed = (await (await handleRequest(get("/2.json"), runtime)).json()) as { name: string };

    assert.deepEqual(plain, suffixed);
  });

  it("works when the baseURI has a path prefix", async () => {
    const { runtime } = makeRuntime({ chain: { totalSupply: 5 } });

    const response = await handleRequest(get("/metadata/tokens/2"), runtime);
    const body = (await response.json()) as { name: string };

    assert.equal(body.name, "Artwork 1");
  });

  it("404s a token outside the drop", async () => {
    const { runtime } = makeRuntime({ chain: { totalSupply: 10 } });

    assert.equal((await handleRequest(get("/0"), runtime)).status, 404);
    assert.equal((await handleRequest(get("/11"), runtime)).status, 404);
  });

  it("answers HEAD with the same headers and no body", async () => {
    const { runtime } = makeRuntime({ chain: { totalSupply: 5 } });

    const response = await handleRequest(
      new Request("https://drop.test/2", { method: "HEAD" }),
      runtime,
    );

    assert.equal(response.status, 200);
    assert.equal(response.headers.get("x-reveal-state"), "minted");
    assert.equal(await response.text(), "");
  });

  it("allows cross origin reads", async () => {
    const { runtime } = makeRuntime({ chain: { totalSupply: 5 } });

    const response = await handleRequest(get("/2"), runtime);
    assert.equal(response.headers.get("access-control-allow-origin"), "*");

    const preflight = await handleRequest(
      new Request("https://drop.test/2", { method: "OPTIONS" }),
      runtime,
    );
    assert.equal(preflight.status, 204);
  });
});

describe("cache headers", () => {
  it("lets a revealed token be cached indefinitely", async () => {
    const { runtime } = makeRuntime({ chain: { totalSupply: 5 } });

    const cacheControl = (await handleRequest(get("/1"), runtime)).headers.get("cache-control");

    assert.match(cacheControl ?? "", /immutable/);
    assert.match(cacheControl ?? "", /max-age=31536000/);
  });

  it("never lets an unrevealed token be cached", async () => {
    // This is the one that bites people. A cached placeholder outlives the mint
    // and the token looks broken until the entry expires.
    const { runtime } = makeRuntime({ chain: { totalSupply: 5 } });

    const cacheControl = (await handleRequest(get("/6"), runtime)).headers.get("cache-control") ?? "";

    assert.match(cacheControl, /max-age=0/);
    assert.match(cacheControl, /s-maxage=0/);
    assert.match(cacheControl, /must-revalidate/);
    assert.doesNotMatch(cacheControl, /immutable/);
  });
});

describe("failing closed", () => {
  it("serves the placeholder when the chain is unreachable", async () => {
    const { runtime } = makeRuntime({ chain: { totalSupply: 5, down: true } });

    const response = await handleRequest(get("/1"), runtime);
    const body = (await response.json()) as { name: string };

    assert.equal(response.headers.get("x-reveal-state"), "rpc-unavailable");
    assert.equal(body.name, "Unrevealed #1");
    assert.doesNotMatch(response.headers.get("cache-control") ?? "", /immutable/);
  });

  it("keeps serving revealed tokens after the chain goes away", async () => {
    const { runtime, chain } = makeRuntime({
      chain: { totalSupply: 5 },
      config: { mintState: { mode: "sequential", ttlSeconds: 0 } },
    });

    assert.equal((await handleRequest(get("/5"), runtime)).headers.get("x-reveal-state"), "minted");

    chain.down = true;

    assert.equal(
      (await handleRequest(get("/5"), runtime)).headers.get("x-reveal-state"),
      "minted",
      "a token already known minted does not need the chain again",
    );
  });

  it("never un-reveals a token when supply drops, as a burn makes it", async () => {
    const { runtime, chain } = makeRuntime({
      chain: { totalSupply: 5 },
      config: { mintState: { mode: "sequential", ttlSeconds: 0 } },
    });

    await handleRequest(get("/5"), runtime);
    chain.totalSupply = 3;

    assert.equal((await handleRequest(get("/5"), runtime)).headers.get("x-reveal-state"), "minted");
  });

  it("withholds everything when the shuffle is on but the seed is missing", async () => {
    // Guessing here would serve the unshuffled order, which is both the wrong
    // artwork and a leak of the order the shuffle exists to hide.
    const { runtime } = makeRuntime({
      chain: { totalSupply: 5 },
      config: {
        reveal: { mode: "on-mint", shuffle: { enabled: true, commitment: "0xabc" } },
      },
    });

    const response = await handleRequest(get("/1"), runtime);
    const body = (await response.json()) as { name: string };

    assert.equal(response.headers.get("x-reveal-state"), "metadata-missing");
    assert.equal(body.name, "Unrevealed #1");
    assert.equal(response.headers.get("cache-control"), "no-store");
  });
});

describe("reveal modes", () => {
  it('reveals everything when the mode is "always"', async () => {
    const { runtime } = makeRuntime({
      chain: { totalSupply: 0 },
      config: { reveal: { mode: "always", shuffle: { enabled: false } } },
    });

    const response = await handleRequest(get("/9"), runtime);

    assert.equal(response.headers.get("x-reveal-state"), "reveal-all");
    assert.match(response.headers.get("cache-control") ?? "", /immutable/);
  });

  it('reveals nothing when the mode is "never"', async () => {
    const { runtime } = makeRuntime({
      chain: { totalSupply: 10 },
      config: { reveal: { mode: "never", shuffle: { enabled: false } } },
    });

    assert.equal(
      (await handleRequest(get("/1"), runtime)).headers.get("x-reveal-state"),
      "reveal-none",
    );
  });

  it("reveals everything when REVEAL_ALL is set, whatever the chain says", async () => {
    const { runtime, chain } = makeRuntime({
      chain: { totalSupply: 0 },
      env: { REVEAL_ALL: "true" },
    });

    const response = await handleRequest(get("/9"), runtime);

    assert.equal(response.headers.get("x-reveal-state"), "reveal-all");
    assert.equal(chain.rpcCalls, 0, "no need to ask the chain at all");
  });
});

describe("rpc usage", () => {
  it("answers a burst of requests with a single totalSupply call", async () => {
    const { runtime, chain } = makeRuntime({ chain: { totalSupply: 5 } });

    await Promise.all(
      Array.from({ length: 50 }, (_, i) => handleRequest(get(`/${(i % 10) + 1}`), runtime)),
    );

    assert.equal(chain.rpcCalls, 1, `expected one RPC call, made ${chain.rpcCalls}`);
  });

  it("checks tokens one at a time in ownerOf mode", async () => {
    const { runtime, chain } = makeRuntime({
      chain: { totalSupply: 5 },
      config: { mintState: { mode: "ownerOf", ttlSeconds: 10 } },
    });

    await handleRequest(get("/2"), runtime);
    await handleRequest(get("/2"), runtime);
    await handleRequest(get("/3"), runtime);

    assert.equal(chain.rpcCalls, 2, "one call per distinct token, then cached");
  });
});

describe("status and provenance", () => {
  it("reports a healthy setup", async () => {
    const { runtime } = makeRuntime({ chain: { totalSupply: 4 } });
    await handleRequest(get("/1"), runtime);

    const body = (await (await handleRequest(get("/status"), runtime)).json()) as {
      ok: boolean;
      problems: string[];
      reveal: { revealedThrough: number };
    };

    assert.equal(body.ok, true, `problems: ${JSON.stringify(body.problems)}`);
    assert.equal(body.reveal.revealedThrough, 4);
  });

  it("never leaks the RPC URL, which usually contains an API key", async () => {
    const { runtime } = makeRuntime({});

    const text = await (await handleRequest(get("/status"), runtime)).text();

    assert.doesNotMatch(text, /\/v2\/key/);
    assert.match(text, /rpc\.test/);
  });

  it("keeps the seed private until it is deliberately published", async () => {
    const withSeed = makeRuntime({
      config: { reveal: { mode: "on-mint", shuffle: { enabled: true, commitment: "0xabc" } } },
      env: { SHUFFLE_SEED: "super-secret-seed" },
    });

    const hidden = await (await handleRequest(get("/provenance"), withSeed.runtime)).text();
    assert.doesNotMatch(hidden, /super-secret-seed/);

    const published = makeRuntime({
      config: { reveal: { mode: "on-mint", shuffle: { enabled: true, commitment: "0xabc" } } },
      env: { SHUFFLE_SEED: "super-secret-seed", PUBLISH_SEED: "true" },
    });

    const shown = await (await handleRequest(get("/provenance"), published.runtime)).text();
    assert.match(shown, /super-secret-seed/);
  });

  it("flags an unusable configuration at /status", async () => {
    const { runtime } = makeRuntime({
      config: { reveal: { mode: "on-mint", shuffle: { enabled: true, commitment: "0xabc" } } },
    });

    const body = (await (await handleRequest(get("/status"), runtime)).json()) as {
      ok: boolean;
      problems: string[];
    };

    assert.equal(body.ok, false);
    assert.match(body.problems.join(" "), /SHUFFLE_SEED/);
  });
});
