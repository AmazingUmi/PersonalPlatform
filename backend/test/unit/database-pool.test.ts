import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { Database, resolveDatabasePoolMax } from "../../src/core/database/index.js";

describe("database pool startup configuration", () => {
  it("preserves the legacy default and accepts explicit supported capacities", () => {
    assert.equal(resolveDatabasePoolMax({}), 10);
    for (const max of [1, 4, 10, 100]) {
      assert.equal(resolveDatabasePoolMax({ DATABASE_POOL_MAX: String(max) }), max);
    }
  });

  it("rejects malformed, empty and out-of-range supplied values", () => {
    for (const value of ["", " ", " 4", "4 ", "0", "-1", "1.5", "1e1", "Infinity", "NaN", "four", "101", "9999999999999999999999999"]) {
      assert.throws(() => resolveDatabasePoolMax({ DATABASE_POOL_MAX: value }), /DATABASE_POOL_MAX/, value);
    }
  });

  it("validates programmatic options before constructing a pool", () => {
    for (const max of [0, -1, 1.5, 101, Infinity, NaN]) {
      assert.throws(() => new Database("postgresql://unused", undefined, { max }), /DATABASE_POOL_MAX/);
    }
  });
});
