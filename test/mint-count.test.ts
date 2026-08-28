/**
 * Counting mints, rather than counting tokens that still exist.
 *
 * Sequential mode turns one number into "every token ID up to here is minted",
 * so which number it reads decides whether a burn quietly parks the newest
 * tokens on the placeholder. `totalSupply()` is minted minus burned and gets
 * this wrong; `getMintStats` reports `_totalMinted()` and gets it right.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { handleRequest } from "../src/handler.ts";
import { get, makeRuntime } from "./helpers.ts";

/** The reveal state header, which says why a token was served the way it was. */
async function stateOf(path: string, runtime: Parameters<typeof handleRequest>[1]) {
  const response = await handleRequest(get(path), runtime);
  return response.headers.get("x-reveal-state");
}

describe("a drop somebody has burned from", () => {
  it("still reveals the highest minted token", async () => {
    // Five minted, one of them burned, so totalSupply() answers 4. Reading that
    // as a high water mark leaves token 5 on the placeholder until a sixth mint
    // lands, and forever if the drop never mints out.
    const { runtime } = makeRuntime({ chain: { totalSupply: 4, totalMinted: 5 } });

    assert.equal(await stateOf("/5", runtime), "minted");
  });

  it("does not reveal past the mint", async () => {
    const { runtime } = makeRuntime({ chain: { totalSupply: 4, totalMinted: 5 } });

    assert.equal(await stateOf("/6", runtime), "unminted");
  });

  it("costs no extra call, because it replaces the totalSupply read", async () => {
    const { runtime, chain } = makeRuntime({ chain: { totalSupply: 4, totalMinted: 5 } });

    await Promise.all(
      Array.from({ length: 20 }, (_, i) => handleRequest(get(`/${(i % 10) + 1}`), runtime)),
    );

    assert.equal(chain.rpcCalls, 1, `expected one RPC call, made ${chain.rpcCalls}`);
  });
});

describe("a contract without getMintStats", () => {
  it("falls back to totalSupply", async () => {
    const { runtime } = makeRuntime({
      chain: { totalSupply: 4, supportsMintStats: false },
    });

    assert.equal(await stateOf("/4", runtime), "minted");
    assert.equal(await stateOf("/5", runtime), "unminted");
  });

  it("probes once, not once per poll", async () => {
    const { runtime, chain } = makeRuntime({
      chain: { totalSupply: 4, supportsMintStats: false },
      config: { mintState: { mode: "sequential", ttlSeconds: 0 } },
    });

    // Tokens above the high water mark, so each request actually polls rather
    // than answering from a mark that already settles the question.
    await handleRequest(get("/5"), runtime);
    const afterProbe = chain.rpcCalls;
    await handleRequest(get("/6"), runtime);
    await handleRequest(get("/7"), runtime);

    assert.equal(afterProbe, 2, "the first read probes, then falls back");
    assert.equal(
      chain.rpcCalls - afterProbe,
      2,
      "later polls read totalSupply only, having remembered the answer",
    );
  });

  it("says so at /status", async () => {
    const { runtime } = makeRuntime({
      chain: { totalSupply: 4, supportsMintStats: false },
    });
    await handleRequest(get("/1"), runtime);

    const body = (await (await handleRequest(get("/status"), runtime)).json()) as {
      mintState: { supplyReader: string; mintedCount: number };
    };

    assert.equal(body.mintState.supplyReader, "total-supply");
    assert.equal(body.mintState.mintedCount, 4);
  });
});

describe("a mint count that cannot be true", () => {
  it("is not believed, because it would reveal the whole drop", async () => {
    // maxSupply is 10 here. A count of 999,999 is either the wrong contract or
    // an unrelated function answering to the same four bytes, and the high
    // water mark is clamped to tokenIdEnd, so trusting it reveals everything.
    const { runtime } = makeRuntime({ chain: { totalSupply: 0, totalMinted: 999_999 } });

    assert.equal(await stateOf("/10", runtime), "unminted");
    assert.equal(await stateOf("/1", runtime), "unminted");
  });

  it("falls back to totalSupply rather than giving up", async () => {
    const { runtime } = makeRuntime({ chain: { totalSupply: 3, totalMinted: 999_999 } });

    assert.equal(await stateOf("/3", runtime), "minted");
    assert.equal(await stateOf("/4", runtime), "unminted");
  });

  it("treats a truncated reply as no answer at all", async () => {
    // One word where three were expected. Reading the first of them as the
    // mint count is how a garbled reply becomes an early reveal.
    const { runtime } = makeRuntime({
      chain: { totalSupply: 2, mintStatsRaw: `0x${"f".repeat(64)}` },
    });

    assert.equal(await stateOf("/2", runtime), "minted");
    assert.equal(await stateOf("/3", runtime), "unminted");
  });
});

describe("an unreachable endpoint during the mint count read", () => {
  it("fails closed rather than falling back to a stale reader", async () => {
    const { runtime } = makeRuntime({ chain: { totalSupply: 5, down: true } });

    assert.equal(await stateOf("/1", runtime), "rpc-unavailable");
  });
});
