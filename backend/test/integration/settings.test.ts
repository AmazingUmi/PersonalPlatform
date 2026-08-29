import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { Database } from "../../src/core/database/index.js";
import { withFixturePlatform } from "../helpers/platform.js";
import { resetDatabase } from "../helpers/db.js";

let db: Database;

before(async () => {
  db = await resetDatabase();
});

after(async () => {
  // resetDatabase() may have failed; teardown must stay safe.
  if (db) await db.close();
});

describe("core settings api", () => {
  it("round-trips a dashboard layout value", async () => {
    await withFixturePlatform({ database: db, manifests: [] }, async (platform) => {
      const put = await platform.app.inject({
        method: "PUT",
        url: "/api/core/settings/dashboard.widgets",
        payload: { value: ["assets:summary", "tasks:today"] },
      });
      assert.equal(put.statusCode, 200);

      const get = await platform.app.inject({ method: "GET", url: "/api/core/settings/dashboard.widgets" });
      assert.equal(get.statusCode, 200);
      assert.deepEqual(get.json().value, ["assets:summary", "tasks:today"]);

      // Overwrite persists the latest value.
      const put2 = await platform.app.inject({
        method: "PUT",
        url: "/api/core/settings/dashboard.widgets",
        payload: { value: [] },
      });
      assert.equal(put2.statusCode, 200);
      const get2 = await platform.app.inject({ method: "GET", url: "/api/core/settings/dashboard.widgets" });
      assert.deepEqual(get2.json().value, []);

      const row = await db.context().query<{ key: string }>("SELECT key FROM core.settings");
      assert.equal(row.rows.length, 1);
    });
  });

  it("returns 404 for unknown settings and validates keys", async () => {
    await withFixturePlatform({ database: db, manifests: [] }, async (platform) => {
      const missing = await platform.app.inject({ method: "GET", url: "/api/core/settings/never.set" });
      assert.equal(missing.statusCode, 404);
      assert.equal(missing.json().error.code, "setting_not_found");

      const invalid = await platform.app.inject({
        method: "PUT",
        url: "/api/core/settings/Bad Key",
        payload: { value: 1 },
      });
      assert.equal(invalid.statusCode, 400);

      const noValue = await platform.app.inject({
        method: "PUT",
        url: "/api/core/settings/valid.key",
        payload: {},
      });
      assert.equal(noValue.statusCode, 400);
    });
  });
});
