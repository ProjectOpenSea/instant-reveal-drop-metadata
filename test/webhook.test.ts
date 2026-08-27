import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { describe, it } from "node:test";
import { handleRequest } from "../src/handler.ts";
import { extractMintedTokenIds, parseTokenId, timingSafeEqual } from "../src/webhook.ts";
import { CONTRACT, get, makeRuntime } from "./helpers.ts";

const SIGNING_KEY = "whsec_test_key";
const SECRET = "shared-secret";

function post(path: string, body: unknown, headers: Record<string, string> = {}): Request {
  return new Request(`https://drop.test${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
}

function alchemyRequest(body: unknown, key = SIGNING_KEY): Request {
  const raw = JSON.stringify(body);
  const signature = createHmac("sha256", key).update(raw, "utf8").digest("hex");
  return new Request("https://drop.test/webhook/alchemy", {
    method: "POST",
    headers: { "content-type": "application/json", "x-alchemy-signature": signature },
    body: raw,
  });
}

const nftActivityPayload = {
  webhookId: "wh_test",
  id: "whevt_test",
  type: "NFT_ACTIVITY",
  event: {
    network: "BASE_MAINNET",
    activity: [
      {
        fromAddress: "0x0000000000000000000000000000000000000000",
        toAddress: "0x9999999999999999999999999999999999999999",
        contractAddress: CONTRACT,
        blockNum: "0x1000",
        erc721TokenId: "0x7",
        category: "erc721",
      },
    ],
  },
};

describe("the generic webhook", () => {
  it("is not there at all until you configure a secret", async () => {
    const { runtime } = makeRuntime({ chain: { totalSupply: 0 } });

    const response = await handleRequest(post("/webhook/mint", { tokenIds: [3] }), runtime);

    assert.equal(response.status, 404);
  });

  it("rejects a wrong bearer token", async () => {
    const { runtime } = makeRuntime({ env: { WEBHOOK_SECRET: SECRET } });

    const response = await handleRequest(
      post("/webhook/mint", { tokenIds: [3] }, { authorization: "Bearer nope" }),
      runtime,
    );

    assert.equal(response.status, 401);
  });

  it("reveals a token immediately, without asking the chain", async () => {
    const { runtime, chain } = makeRuntime({
      chain: { totalSupply: 0 },
      env: { WEBHOOK_SECRET: SECRET },
    });

    const webhook = await handleRequest(
      post("/webhook/mint", { tokenIds: [7] }, { authorization: `Bearer ${SECRET}` }),
      runtime,
    );
    assert.equal(webhook.status, 200);

    const token = await handleRequest(get("/7"), runtime);
    assert.equal(token.headers.get("x-reveal-state"), "minted");
    assert.equal(chain.rpcCalls, 0, "the webhook was enough");
  });

  it("accepts a supply cursor as well as individual ids", async () => {
    const { runtime } = makeRuntime({
      chain: { totalSupply: 0 },
      env: { WEBHOOK_SECRET: SECRET },
    });

    await handleRequest(
      post("/webhook/mint", { revealedThrough: 5 }, { authorization: `Bearer ${SECRET}` }),
      runtime,
    );

    assert.equal((await handleRequest(get("/5"), runtime)).headers.get("x-reveal-state"), "minted");
  });

  it("ignores token ids that are not part of this drop", async () => {
    const { runtime } = makeRuntime({
      chain: { totalSupply: 0 },
      env: { WEBHOOK_SECRET: SECRET },
    });

    const response = await handleRequest(
      post("/webhook/mint", { tokenIds: [0, 11, 4000, -1] }, { authorization: `Bearer ${SECRET}` }),
      runtime,
    );
    const body = (await response.json()) as { tokenIdsApplied: number };

    assert.equal(body.tokenIdsApplied, 0);
  });

  it("cannot hide a token that is already revealed", async () => {
    const { runtime } = makeRuntime({
      chain: { totalSupply: 8 },
      env: { WEBHOOK_SECRET: SECRET },
      config: { mintState: { mode: "sequential", ttlSeconds: 0 } },
    });

    await handleRequest(get("/8"), runtime);
    await handleRequest(
      post("/webhook/mint", { revealedThrough: 2 }, { authorization: `Bearer ${SECRET}` }),
      runtime,
    );

    assert.equal((await handleRequest(get("/8"), runtime)).headers.get("x-reveal-state"), "minted");
  });

  it("only answers POST", async () => {
    const { runtime } = makeRuntime({ env: { WEBHOOK_SECRET: SECRET } });

    const response = await handleRequest(get("/webhook/mint"), runtime);

    assert.equal(response.status, 405);
  });
});

describe("the alchemy webhook", () => {
  it("is not there at all until you configure a signing key", async () => {
    const { runtime } = makeRuntime({});

    const response = await handleRequest(alchemyRequest(nftActivityPayload), runtime);

    assert.equal(response.status, 404);
  });

  it("rejects a body whose signature does not match", async () => {
    const { runtime } = makeRuntime({ env: { ALCHEMY_WEBHOOK_SIGNING_KEY: SIGNING_KEY } });

    const response = await handleRequest(
      alchemyRequest(nftActivityPayload, "the-wrong-key"),
      runtime,
    );

    assert.equal(response.status, 401);
  });

  it("reveals the token named in a correctly signed payload", async () => {
    const { runtime, chain } = makeRuntime({
      chain: { totalSupply: 0 },
      env: { ALCHEMY_WEBHOOK_SIGNING_KEY: SIGNING_KEY },
    });

    const response = await handleRequest(alchemyRequest(nftActivityPayload), runtime);
    const body = (await response.json()) as { tokenIdsApplied: number };

    assert.equal(response.status, 200);
    assert.equal(body.tokenIdsApplied, 1);
    assert.equal((await handleRequest(get("/7"), runtime)).headers.get("x-reveal-state"), "minted");
    assert.equal(chain.rpcCalls, 0);
  });
});

describe("reading token ids out of a provider payload", () => {
  it("finds them in an NFT activity payload", () => {
    assert.deepEqual(extractMintedTokenIds(nftActivityPayload, CONTRACT), [7]);
  });

  it("ignores activity on a different contract", () => {
    const payload = {
      event: {
        activity: [
          { contractAddress: "0x2222222222222222222222222222222222222222", erc721TokenId: "0x5" },
        ],
      },
    };

    assert.deepEqual(extractMintedTokenIds(payload, CONTRACT), []);
  });

  it("finds them in raw Transfer logs from a custom webhook", () => {
    const payload = {
      event: {
        data: {
          block: {
            logs: [
              {
                account: { address: CONTRACT },
                topics: [
                  "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef",
                  "0x0000000000000000000000000000000000000000000000000000000000000000",
                  "0x0000000000000000000000009999999999999999999999999999999999999999",
                  "0x0000000000000000000000000000000000000000000000000000000000000029",
                ],
              },
            ],
          },
        },
      },
    };

    assert.deepEqual(extractMintedTokenIds(payload, CONTRACT), [41]);
  });

  it("is not confused by an address match with the wrong event", () => {
    const payload = {
      logs: [
        {
          address: CONTRACT,
          topics: [
            "0x8c5be1e5ebec7d5bd14f71427d1e84f3dd0314c0f7b2291e5b200ac8c7c3b925",
            "0x00",
            "0x00",
            "0x0000000000000000000000000000000000000000000000000000000000000029",
          ],
        },
      ],
    };

    assert.deepEqual(extractMintedTokenIds(payload, CONTRACT), []);
  });

  it("reads decimal and hex token ids, and rejects nonsense", () => {
    assert.equal(parseTokenId(41), 41);
    assert.equal(parseTokenId("41"), 41);
    assert.equal(parseTokenId("0x29"), 41);
    assert.equal(parseTokenId("  41 "), 41);
    assert.equal(parseTokenId("not a number"), null);
    assert.equal(parseTokenId(-1), null);
    assert.equal(parseTokenId(1.5), null);
    assert.equal(parseTokenId(null), null);
    assert.equal(
      parseTokenId("0xffffffffffffffffffffffffffffffff"),
      null,
      "too large for a JS integer",
    );
  });
});

describe("secret comparison", () => {
  it("matches only identical strings", () => {
    assert.equal(timingSafeEqual("abc", "abc"), true);
    assert.equal(timingSafeEqual("abc", "abd"), false);
    assert.equal(timingSafeEqual("abc", "abcd"), false);
    assert.equal(timingSafeEqual("", ""), false);
    assert.equal(timingSafeEqual("abc", ""), false);
  });
});
