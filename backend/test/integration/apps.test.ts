import assert from "node:assert/strict";
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { after, before, describe, it } from "node:test";
import { Database } from "../../src/core/database/index.js";
import { createLogger } from "../../src/core/logging/index.js";
import { createPlatform, type Platform } from "../../src/core/platform.js";
import type { PlatformConfig } from "../../src/core/config/index.js";
import { runMigrations } from "../../src/core/database/migrate.js";
import { coreMigrationTarget, runAppMigrations } from "../../src/core/database/startup-migrations.js";
import { backendAppModules, frontendAppIds } from "../../src/generated/apps.js";
import { resetDatabase, TEST_DATABASE_URL } from "../helpers/db.js";

const log = createLogger("fatal");
const repoRoot = resolve(import.meta.dirname, "..", "..", "..");
let db: Database;
let platform: Platform;
let tmpRoot: string;

before(async () => {
  db = await resetDatabase();
  await runMigrations({ databaseUrl: TEST_DATABASE_URL, targets: [coreMigrationTarget(repoRoot)], log });

  tmpRoot = mkdtempSync(join(tmpdir(), "pp-apps-e2e-"));
  mkdirSync(join(tmpRoot, "storage"), { recursive: true });
  mkdirSync(join(tmpRoot, "config"), { recursive: true });
  writeFileSync(join(tmpRoot, "config", "platform.yaml"), "platform:\n  name: test\n");
  for (const appId of ["assets", "tasks", "mini_game"]) {
    mkdirSync(join(tmpRoot, "apps", appId), { recursive: true });
    copyFileSync(join(repoRoot, "apps", appId, "app.yaml"), join(tmpRoot, "apps", appId, "app.yaml"));
  }

  const config: PlatformConfig = {
    platform: { name: "test", environment: "test" },
    apps: { manifests_directory: "apps", enabled: {} },
    storage: { driver: "local", root: "storage" },
  };

  platform = await createPlatform({
    config,
    root: tmpRoot,
    log,
    database: db,
    backendModules: backendAppModules,
    frontendAppIds,
    beforeActivation: async () => {
      await runAppMigrations({
        databaseUrl: TEST_DATABASE_URL,
        root: repoRoot,
        manifestsDir: join(repoRoot, "apps"),
        database: db,
        log,
      });
    },
  });
});

after(async () => {
  await platform.stop().catch(() => undefined);
  rmSync(tmpRoot, { recursive: true, force: true });
  await db.close();
});

describe("three validation apps", () => {
  it("lists all three apps as enabled", () => {
    const apps = platform.getApps();
    const ids = apps.map((app) => app.id).sort();
    assert.deepEqual(ids, ["assets", "mini_game", "tasks"]);
    assert.ok(apps.every((app) => app.status === "enabled"));
  });

  it("assets: create category, create item, search and list", async () => {
    const category = await platform.app.inject({
      method: "POST",
      url: "/api/apps/assets/categories",
      payload: { name: "Electronics" },
    });
    assert.equal(category.statusCode, 201);

    const created = await platform.app.inject({
      method: "POST",
      url: "/api/apps/assets/items",
      payload: { name: "Laptop", categoryId: category.json().id, quantity: 1 },
    });
    assert.equal(created.statusCode, 201);
    assert.equal(created.json().name, "Laptop");

    const search = await platform.app.inject({ method: "GET", url: "/api/apps/assets/items?q=Lap" });
    assert.equal(search.json().items.length, 1);

    const summary = await platform.app.inject({ method: "GET", url: "/api/apps/assets/summary" });
    assert.equal(summary.json().items, 1);
  });

  it("assets: stores attachments through platform storage", async () => {
    const created = await platform.app.inject({
      method: "POST",
      url: "/api/apps/assets/items",
      payload: { name: "Camera" },
    });
    const itemId = created.json().id;

    const upload = await platform.app.inject({
      method: "POST",
      url: `/api/apps/assets/items/${itemId}/attachments`,
      payload: { filename: "receipt.txt", contentType: "text/plain", dataBase64: Buffer.from("hello").toString("base64") },
    });
    assert.equal(upload.statusCode, 201);

    const list = await platform.app.inject({ method: "GET", url: `/api/apps/assets/items/${itemId}/attachments` });
    assert.equal(list.json().items.length, 1);
  });

  it("tasks: create, complete and summarize", async () => {
    const created = await platform.app.inject({
      method: "POST",
      url: "/api/apps/tasks/tasks",
      payload: { title: "Write docs" },
    });
    assert.equal(created.statusCode, 201);

    const completed = await platform.app.inject({
      method: "PUT",
      url: `/api/apps/tasks/tasks/${created.json().id}`,
      payload: { status: "done" },
    });
    assert.equal(completed.json().status, "done");
    assert.ok(completed.json().completed_at);

    const summary = await platform.app.inject({ method: "GET", url: "/api/apps/tasks/summary" });
    assert.equal(summary.json().done, 1);
  });

  it("mini_game: persists and loads a save", async () => {
    const board = [[2, 0, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0]];
    const save = await platform.app.inject({
      method: "PUT",
      url: "/api/apps/mini_game/saves",
      payload: { score: 64, board },
    });
    assert.equal(save.statusCode, 200);
    assert.equal(save.json().score, 64);

    const loaded = await platform.app.inject({ method: "GET", url: "/api/apps/mini_game/saves" });
    assert.equal(loaded.json().save.score, 64);

    const summary = await platform.app.inject({ method: "GET", url: "/api/apps/mini_game/summary" });
    assert.equal(summary.json().highScore, 64);
  });

  it("disabling an app blocks its API but preserves data", async () => {
    const created = await platform.app.inject({
      method: "POST",
      url: "/api/apps/assets/items",
      payload: { name: "Keep Me" },
    });
    const itemId = created.json().id;

    await platform.setAppEnabled("assets", false);
    const blocked = await platform.app.inject({ method: "GET", url: "/api/apps/assets/items" });
    assert.equal(blocked.statusCode, 404, "disabled app API returns 404");

    await platform.setAppEnabled("assets", true);
    const restored = await platform.app.inject({ method: "GET", url: `/api/apps/assets/items/${itemId}` });
    assert.equal(restored.statusCode, 200);
    assert.equal(restored.json().name, "Keep Me");
  });
});
