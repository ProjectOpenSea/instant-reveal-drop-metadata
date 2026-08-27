/**
 * Which file is which position.
 *
 * This decides which artwork every token gets, and it cannot be corrected once
 * the tokens are minted, so anything ambiguous has to fail the build rather
 * than pick an order and print "ok".
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { MetadataOrderError, orderMetadataFiles } from "../scripts/shared.ts";

const DIR = "metadata";

describe("ordering a metadata set", () => {
  it("counts, rather than sorting as text", () => {
    // Sorted as text this is 1, 10, 2, 3, ... so 10 landing last is the point.
    const shuffled = ["10.json", "2.json", "7.json", "1.json", "9.json", "3.json"];
    const rest = ["4.json", "5.json", "6.json", "8.json"];

    const ordered = orderMetadataFiles([...shuffled, ...rest], DIR);

    assert.deepEqual(
      ordered,
      Array.from({ length: 10 }, (_, i) => `${i + 1}.json`),
    );
  });

  it("reads zero padded names as the numbers they are", () => {
    const ordered = orderMetadataFiles(["003.json", "001.json", "002.json"], DIR);

    assert.deepEqual(ordered, ["001.json", "002.json", "003.json"]);
  });

  it("accepts a set that starts at zero", () => {
    assert.deepEqual(orderMetadataFiles(["1.json", "0.json"], DIR), ["0.json", "1.json"]);
  });

  it("accepts a single file", () => {
    assert.deepEqual(orderMetadataFiles(["7.json"], DIR), ["7.json"]);
  });
});

describe("refusing to guess an order", () => {
  it("rejects a leftover draft sharing a position", () => {
    // The bug this exists for: 1.backup.json sorted ahead of 1.json and shifted
    // every token onto the previous token's artwork, silently.
    assert.throws(
      () => orderMetadataFiles(["1.json", "1.backup.json", "2.json"], DIR),
      (error: unknown) =>
        error instanceof MetadataOrderError && /same position/.test((error as Error).message),
    );
  });

  it("names both of the colliding files", () => {
    try {
      orderMetadataFiles(["1.json", "1.backup.json"], DIR);
      assert.fail("expected a MetadataOrderError");
    } catch (error) {
      const message = (error as Error).message;
      assert.match(message, /1\.backup\.json/);
      assert.match(message, /1\.json/);
    }
  });

  it("treats a zero padded duplicate as a duplicate", () => {
    assert.throws(
      () => orderMetadataFiles(["01.json", "1.json"], DIR),
      (error: unknown) => error instanceof MetadataOrderError,
    );
  });

  it("rejects a gap, which would shift everything after it", () => {
    assert.throws(
      () => orderMetadataFiles(["1.json", "2.json", "4.json"], DIR),
      (error: unknown) =>
        error instanceof MetadataOrderError && /missing 3/.test((error as Error).message),
    );
  });

  it("lists several missing positions without printing all of them", () => {
    try {
      orderMetadataFiles(["1.json", "99.json"], DIR);
      assert.fail("expected a MetadataOrderError");
    } catch (error) {
      const message = (error as Error).message;
      assert.match(message, /missing 2, 3, 4/);
      assert.match(message, /\.\.\./);
    }
  });

  it("rejects names that are not positions at all", () => {
    // "art-10.json" sorts before "art-2.json" as text, so alphabetical order
    // here is quietly the wrong order.
    assert.throws(
      () => orderMetadataFiles(["art-1.json", "art-2.json", "art-10.json"], DIR),
      (error: unknown) =>
        error instanceof MetadataOrderError &&
        /not named by position/.test((error as Error).message),
    );
  });

  it("rejects one stray file among a good set", () => {
    assert.throws(
      () => orderMetadataFiles(["1.json", "2.json", "notes.json"], DIR),
      (error: unknown) =>
        error instanceof MetadataOrderError && /notes\.json/.test((error as Error).message),
    );
  });

  it("points at manifest.json as the way to state an order explicitly", () => {
    try {
      orderMetadataFiles(["alice.json"], DIR);
      assert.fail("expected a MetadataOrderError");
    } catch (error) {
      assert.match((error as Error).message, /manifest\.json/);
    }
  });
});
