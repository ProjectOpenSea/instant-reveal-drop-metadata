import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  buildPermutation,
  canonicalJson,
  manifestHash,
  seedCommitment,
  sha256Hex,
} from "../src/shuffle.ts";

describe("the shuffle", () => {
  it("gives the same mapping every time, which is the whole point", async () => {
    const a = await buildPermutation("seed-one", 1000);
    const b = await buildPermutation("seed-one", 1000);

    assert.deepEqual(a, b);
  });

  it("gives a different mapping for a different seed", async () => {
    const a = await buildPermutation("seed-one", 1000);
    const b = await buildPermutation("seed-two", 1000);

    assert.notDeepEqual(a, b);
  });

  it("uses every index exactly once", async () => {
    const size = 5000;
    const permutation = await buildPermutation("check-bijection", size);

    assert.equal(permutation.length, size);
    assert.equal(new Set(permutation).size, size);
    assert.equal(Math.min(...permutation), 0);
    assert.equal(Math.max(...permutation), size - 1);
  });

  it("actually moves things around", async () => {
    const size = 1000;
    const permutation = await buildPermutation("not-identity", size);
    const fixedPoints = permutation.filter((value, index) => value === index).length;

    // A random permutation leaves about one element in place on average. More
    // than a handful would mean the shuffle is barely shuffling.
    assert.ok(fixedPoints < 10, `${fixedPoints} tokens kept their original artwork`);
  });

  it("handles the edges", async () => {
    assert.deepEqual(await buildPermutation("x", 0), []);
    assert.deepEqual(await buildPermutation("x", 1), [0]);
    assert.equal((await buildPermutation("x", 2)).length, 2);
  });

  it("matches a recorded mapping, so an upgrade cannot silently change it", async () => {
    // If this test ever fails, every drop that used a shuffle would reveal
    // different artwork than it promised. Change the algorithm only with a new
    // version and a new config flag.
    const permutation = await buildPermutation("instant-reveal-golden-seed", 16);

    assert.deepEqual(permutation, [2, 4, 7, 0, 15, 14, 3, 6, 9, 8, 11, 13, 12, 10, 1, 5]);
  });
});

describe("provenance hashes", () => {
  it("commits to a seed without revealing it", async () => {
    const commitment = await seedCommitment("my-seed");

    assert.match(commitment, /^[0-9a-f]{64}$/);
    assert.doesNotMatch(commitment, /my-seed/);
    assert.equal(commitment, await seedCommitment("my-seed"));
    assert.notEqual(commitment, await seedCommitment("my-seed "));
  });

  it("hashes a metadata set independently of key order", async () => {
    const a = [{ name: "One", image: "ipfs://1" }];
    const b = [{ image: "ipfs://1", name: "One" }];

    assert.equal(await manifestHash(a), await manifestHash(b));
  });

  it("notices any change to the metadata set", async () => {
    const original = [{ name: "One" }, { name: "Two" }];
    const edited = [{ name: "One" }, { name: "Two!" }];
    const reordered = [{ name: "Two" }, { name: "One" }];

    const hash = await manifestHash(original);
    assert.notEqual(hash, await manifestHash(edited));
    assert.notEqual(hash, await manifestHash(reordered));
  });

  it("canonicalises nested structures", () => {
    assert.equal(canonicalJson({ b: 1, a: [{ d: 2, c: 3 }] }), '{"a":[{"c":3,"d":2}],"b":1}');
  });

  it("hashes the way every other sha256 implementation does", async () => {
    assert.equal(
      await sha256Hex("abc"),
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    );
  });
});
