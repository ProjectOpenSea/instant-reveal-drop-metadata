/**
 * The ways a reveal could happen early, and the ways this server could be used
 * to spend someone else's money.
 *
 * Everything in the rest of the suite asks whether the server does the right
 * thing when its inputs are sensible. These ask what it does when they are not:
 * a chain that answers with garbage, a caller that walks the whole token range,
 * a body nobody intends to be read.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { handleRequest } from "../src/handler.ts";
import { redact } from "../src/redact.ts";
import { decodeBool, decodeUint256, RpcTransportError } from "../src/rpc.ts";
import { get, makeRuntime } from "./helpers.ts";

describe("return data that is not a full word", () => {
  it("is rejected rather than read as a small number", () => {
    // `0x01` is one byte, not a uint256. Reading its first characters as a
    // value would make it decode to 1, and a non-zero ownerOf result means
    // "this token has an owner".
    assert.throws(() => decodeUint256("0x01"), RpcTransportError);
    assert.throws(() => decodeUint256("0x"), RpcTransportError);
    assert.throws(() => decodeUint256(`0x${"22".padStart(62, "0")}`), RpcTransportError);
  });

  it("still decodes a well formed word", () => {
    assert.equal(decodeUint256(`0x${(255).toString(16).padStart(64, "0")}`), 255n);
  });

  it("reads a short boolean as false", () => {
    assert.equal(decodeBool("0x01"), false);
    assert.equal(decodeBool(`0x${(1).toString(16).padStart(64, "0")}`), true);
  });

  it("does not let a truncated ownerOf reveal an unminted token", async () => {
    const { runtime } = makeRuntime({
      config: { mintState: { mode: "ownerOf", ttlSeconds: 10 } },
      chain: { totalSupply: 0, ownerOfRaw: "0x01" },
    });

    const response = await handleRequest(get("/4"), runtime);
    const body = (await response.json()) as { name: string };

    assert.equal(response.headers.get("x-reveal-state"), "rpc-unavailable");
    assert.equal(body.name, "Unrevealed #4");
  });
});

describe("an endpoint that reports a revert as empty data", () => {
  it("treats an empty ownerOf as an unminted token, not an outage", async () => {
    // Plenty of nodes answer a reverting eth_call with `0x` and no JSON-RPC
    // error. Before, that surfaced as a transport failure on every unminted
    // token, which is most of them for most of a mint.
    const { runtime } = makeRuntime({
      config: { mintState: { mode: "ownerOf", ttlSeconds: 10 } },
      chain: { totalSupply: 0, ownerOfRaw: "0x" },
    });

    const response = await handleRequest(get("/4"), runtime);

    assert.equal(response.headers.get("x-reveal-state"), "unminted");

    const status = (await (await handleRequest(get("/status"), runtime)).json()) as {
      ok: boolean;
      mintState: { lastError: string | null };
    };
    assert.equal(status.mintState.lastError, null);
    assert.equal(status.ok, true);
  });
});

describe("an unreachable endpoint before anything has minted", () => {
  it("stops re-asking on every request", async () => {
    // The cooldown used to need a high water mark to fall back on, so a drop
    // with nothing minted yet retried a dead endpoint once per inbound request
    // -- at the busiest moment a drop ever has.
    const { runtime, chain } = makeRuntime({ chain: { totalSupply: 0, down: true } });

    for (let i = 0; i < 25; i++) {
      const response = await handleRequest(get("/1"), runtime);
      assert.equal(response.headers.get("x-reveal-state"), "rpc-unavailable");
    }

    assert.ok(
      chain.rpcCalls <= 2,
      `expected the failure to be cached, made ${chain.rpcCalls} calls`,
    );
  });
});

describe("a caller walking the whole token range in ownerOf mode", () => {
  it("caps how many chain reads it can start at once", async () => {
    // One HTTP request becomes one RPC call in this mode, so without a ceiling
    // the server hands anyone who can reach it a lever on the operator's RPC
    // bill.
    let open!: () => void;
    const gate = new Promise<void>((resolve) => {
      open = resolve;
    });

    const { runtime, chain } = makeRuntime({
      config: { maxSupply: 1000, mintState: { mode: "ownerOf", ttlSeconds: 10 } },
      chain: { totalSupply: 1000, gate },
    });

    const inflight = Array.from({ length: 300 }, (_, i) =>
      handleRequest(get(`/${i + 1}`), runtime),
    );
    // Let the requests reach the gate before counting.
    await new Promise((resolve) => setTimeout(resolve, 25));
    const started = chain.rpcCalls;
    open();
    const responses = await Promise.all(inflight);

    assert.ok(started <= 64, `expected at most 64 concurrent reads, started ${started}`);

    const throttled = responses.filter((r) => r.headers.get("x-reveal-state") === "throttled");
    assert.ok(throttled.length > 0, "expected some requests to be declined");
    // Declined means withheld. It must never mean revealed.
    for (const response of throttled) {
      const body = (await response.json()) as { name: string };
      assert.match(body.name, /^Unrevealed #/);
      assert.equal(
        response.headers.get("cache-control"),
        "public, max-age=0, s-maxage=0, must-revalidate",
      );
    }
  });

  it("counts what it declined at /status without calling it an error", async () => {
    let open!: () => void;
    const gate = new Promise<void>((resolve) => {
      open = resolve;
    });
    const { runtime } = makeRuntime({
      config: { maxSupply: 1000, mintState: { mode: "ownerOf", ttlSeconds: 10 } },
      chain: { totalSupply: 1000, gate },
    });

    const inflight = Array.from({ length: 200 }, (_, i) =>
      handleRequest(get(`/${i + 1}`), runtime),
    );
    await new Promise((resolve) => setTimeout(resolve, 25));
    open();
    await Promise.all(inflight);

    const status = (await (await handleRequest(get("/status"), runtime)).json()) as {
      ok: boolean;
      mintState: { throttledChecks: number; lastError: string | null };
    };

    assert.ok(status.mintState.throttledChecks > 0);
    assert.equal(status.mintState.lastError, null);
    assert.equal(status.ok, true);
  });
});

describe("redacting what reaches a stranger", () => {
  it("keeps the host and drops the rest of a url", () => {
    assert.equal(
      redact("eth_call request failed: https://eth-mainnet.g.alchemy.com/v2/sekritkey0000000"),
      "eth_call request failed: eth-mainnet.g.alchemy.com/...",
    );
  });

  it("drops anything that looks like a key on its own", () => {
    assert.equal(
      redact("bad auth for AKIAIOSFODNN7EXAMPLEBUTLONGERTHANTHIRTYTWO"),
      "bad auth for (redacted)",
    );
  });

  it("caps the length, so a remote endpoint cannot fill /status", () => {
    assert.ok(redact("x".repeat(5_000)).length <= 305);
  });

  it("leaves an ordinary message alone", () => {
    assert.equal(redact("totalSupply returned HTTP 503"), "totalSupply returned HTTP 503");
  });
});

describe("a token id larger than a javascript number", () => {
  it("is not rounded into the drop's range", async () => {
    const { runtime } = makeRuntime({ chain: { totalSupply: 10 } });

    const response = await handleRequest(get(`/${"9".repeat(40)}`), runtime);

    assert.equal(response.status, 404);
  });
});
