import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { after, before, describe, it } from "node:test";
import { Database } from "../../src/core/database/index.js";
import miniGameApp from "../../src/apps/mini_game/index.js";
import type { BackendAppModule } from "../../src/core/app-registry/types.js";
import type { Platform } from "../../src/core/platform.js";
import { buildFixturePlatform } from "../helpers/platform.js";
import { resetDatabase, TEST_DATABASE_URL } from "../helpers/db.js";
import { runMigrations } from "../../src/core/database/migrate.js";

const repoRoot = resolve(import.meta.dirname, "..", "..", "..");
const miniGameMigrations = [
  readFileSync(join(repoRoot, "apps/mini_game/migrations/20260101000001-init.sql"), "utf8"),
  readFileSync(join(repoRoot, "apps/mini_game/migrations/20260829000002-high-score-revision.sql"), "utf8"),
];

const highScoreEvents: Array<{ score: number; previous: number }> = [];

let db: Database;
let platform: Platform;
let cleanup: () => void;
let root: string;

before(async () => {
  db = await resetDatabase();
  const spySubscriber: BackendAppModule = {
    id: "spy",
    async registerApi() {},
    async registerEvents(ctx) {
      return [
        ctx.events.subscribe<{ score: number; previous: number }>(
          "mini_game.highscore.beaten.v1",
          (event) => {
            highScoreEvents.push(event.payload);
          },
        ),
      ];
    },
  };
  const fixture = await buildFixturePlatform({
    database: db,
    manifests: [
      { id: "mini_game", migrations: miniGameMigrations },
      { id: "spy" },
    ],
    backendModules: { mini_game: miniGameApp, spy: spySubscriber },
  });
  platform = fixture.platform;
  cleanup = fixture.cleanup;
  root = fixture.root;
  await runMigrations({
    databaseUrl: TEST_DATABASE_URL,
    targets: [
      { scope: "mini_game", schema: "mini_game", dir: join(root, "apps", "mini_game", "migrations") },
    ],
  });
});

after(async () => {
  // Setup may have failed partway; teardown must never turn that into a
  // secondary "cannot read properties of undefined" error.
  if (platform) await platform.stop();
  cleanup?.();
  if (db) await db.close();
});

function putSave(body: { score: number; board: number[][]; revision: number }) {
  return platform.app.inject({
    method: "PUT",
    url: "/api/apps/mini_game/saves",
    payload: body,
  });
}

describe("2048 save semantics (FP-2A.3 / FP-2A.4)", () => {
  it("accepts the first save and records the score as high score", async () => {
    const response = await putSave({ score: 100, board: [[2, 0, 0, 0]], revision: 1 });
    assert.equal(response.statusCode, 200);
    const body = response.json();
    assert.equal(body.accepted, true);
    assert.equal(body.save.score, 100);
    assert.equal(body.save.highScore, 100);
    assert.equal(body.save.revision, 1);
  });

  it("keeps the historical high score after a New Game reset (score 0)", async () => {
    const response = await putSave({ score: 0, board: [[0, 0, 2, 0]], revision: 2 });
    assert.equal(response.statusCode, 200);
    const body = response.json();
    assert.equal(body.accepted, true);
    assert.equal(body.save.score, 0);
    assert.equal(body.save.highScore, 100, "new game must not clear the historical high score");
  });

  it("summary reports the historical high score, not the current run", async () => {
    const summary = await platform.app.inject({ method: "GET", url: "/api/apps/mini_game/summary" });
    assert.equal(summary.statusCode, 200);
    assert.equal(summary.json().highScore, 100);
  });

  it("rejects a stale save so an older board can never overwrite a newer one", async () => {
    // Server is at revision 2. A delayed write from revision 1 arrives last.
    const stale = await putSave({ score: 999, board: [[8, 8, 8, 8]], revision: 1 });
    assert.equal(stale.statusCode, 200);
    const body = stale.json();
    assert.equal(body.accepted, false, "stale revision must be rejected");
    assert.equal(body.save.score, 0, "server state is unchanged");

    // Repeating the current revision is an idempotent no-op, also not accepted.
    const repeat = await putSave({ score: 999, board: [[8, 8, 8, 8]], revision: 2 });
    assert.equal(repeat.json().accepted, false);

    const row = await db
      .context()
      .query<{ score: number; high_score: number; revision: number }>(
        "SELECT score, high_score, revision FROM mini_game.saves WHERE id = 'current'",
      );
    assert.equal(row.rows[0]!.score, 0);
    assert.equal(row.rows[0]!.revision, 2);
  });

  it("accepts the next monotonic revision", async () => {
    const response = await putSave({ score: 40, board: [[2, 2, 0, 0]], revision: 3 });
    const body = response.json();
    assert.equal(body.accepted, true);
    assert.equal(body.save.score, 40);
    assert.equal(body.save.highScore, 100, "a lower run score never lowers the high score");
  });

  it("publishes highscore.beaten only when the historical record is exceeded", async () => {
    // Drain async event handlers.
    await new Promise((resolve) => setTimeout(resolve, 50));
    // So far: first score (no record to beat), score 0, stale 999 (rejected),
    // score 40 (below record) — none of these may publish.
    assert.equal(highScoreEvents.length, 0);

    const beaten = await putSave({ score: 250, board: [[4, 4, 4, 4]], revision: 4 });
    assert.equal(beaten.json().accepted, true);
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(highScoreEvents.length, 1, "exceeding the record publishes exactly once");
    assert.equal(highScoreEvents[0]!.score, 250);
    assert.equal(highScoreEvents[0]!.previous, 100);

    // Beating the current run's score but not the record publishes nothing.
    const below = await putSave({ score: 200, board: [[2, 2, 2, 2]], revision: 5 });
    assert.equal(below.json().save.highScore, 250);
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(highScoreEvents.length, 1);
  });

  it("GET /saves returns the full save including revision", async () => {
    const saves = await platform.app.inject({ method: "GET", url: "/api/apps/mini_game/saves" });
    const body = saves.json();
    assert.equal(body.save.revision, 5);
    assert.equal(body.save.score, 200);
    assert.equal(body.save.highScore, 250);
  });

  it("rejects invalid save payloads", async () => {
    const bad = await platform.app.inject({
      method: "PUT",
      url: "/api/apps/mini_game/saves",
      payload: { score: -5, board: [], revision: 6 },
    });
    assert.equal(bad.statusCode, 400);
  });
});
