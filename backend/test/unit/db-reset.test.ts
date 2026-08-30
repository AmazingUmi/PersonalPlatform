import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  APP_SCHEMAS,
  droppableSchemas,
  PLATFORM_SCHEMAS,
  registerTestSchemas,
} from "../helpers/db.js";

/**
 * FP-8.1 regression: resetDatabase() must only ever drop explicitly
 * allowlisted schemas. CI connects as a superuser, so enumerating
 * information_schema.schemata returns system schemas like pg_toast — the old
 * "drop everything non-system" strategy crashed with `cannot drop schema
 * pg_toast`. These tests pin the guard that makes that impossible.
 */
describe("reset schema allowlist (FP-8.1)", () => {
  it("drops the platform schemas but never public or information_schema", () => {
    assert.ok(droppableSchemas().includes("core"));
    for (const schema of APP_SCHEMAS) {
      assert.ok(droppableSchemas().includes(schema), `${schema} is droppable`);
    }
    assert.ok(!droppableSchemas().includes("public"));
    assert.ok(!droppableSchemas().includes("information_schema"));
    assert.deepEqual(
      PLATFORM_SCHEMAS,
      ["core", "assets", "focus", "mini_game", "notes", "tasks"],
      "platform schema set stays explicit",
    );
  });

  it("test-registered schemas join the allowlist", () => {
    registerTestSchemas("lifecyc", "latecol");
    assert.ok(droppableSchemas().includes("lifecyc"));
    assert.ok(droppableSchemas().includes("latecol"));
  });

  it("never drops pg_* or information_schema even if mistakenly registered", () => {
    registerTestSchemas("pg_toast", "pg_temp", "information_schema", "public");
    const droppable = droppableSchemas();
    assert.ok(!droppable.includes("pg_toast"), "pg_toast must never be droppable");
    assert.ok(!droppable.some((name) => name.startsWith("pg_")), "no pg_* schema is droppable");
    assert.ok(!droppable.includes("information_schema"));
    assert.ok(!droppable.includes("public"));
  });

  it("is deterministic: repeated calls return the same set", () => {
    assert.deepEqual(droppableSchemas(), droppableSchemas());
  });
});
