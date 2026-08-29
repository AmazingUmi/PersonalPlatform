import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { Database } from "../../src/core/database/index.js";
import type { BackendAppModule } from "../../src/core/app-registry/types.js";
import type { Platform } from "../../src/core/platform.js";
import { withFixturePlatform } from "../helpers/platform.js";
import { resetDatabase } from "../helpers/db.js";

/**
 * FP-9: activation failures must not leak owner-scoped resources, capability
 * declarations must match what an app can actually use, and activation errors
 * must be persisted by the time the API reports them.
 */

let db: Database;

before(async () => {
  db = await resetDatabase();
});

after(async () => {
  if (db) await db.close();
});

/** Fixture yaml with explicit capability grants. */
function capabilitiesYaml(id: string, capabilities: string[]): string {
  return `manifest_version: 1
id: ${id}
name: ${id}
version: 0.1.0
description: fixture app ${id}
default_enabled: true
frontend:
  route: /${id}
widgets: []
capabilities:
${capabilities.map((c) => `  ${c}: true`).join("\n")}
`;
}

describe("half-failed activation reclaims resources (FP-9.1)", () => {
  it("registerEvents that subscribes then throws leaves no subscription behind", async () => {
    const received: string[] = [];
    const publisher: BackendAppModule = {
      id: "publisher",
      async registerApi(ctx) {
        ctx.api.post("/emit", async (_request, reply) => {
          ctx.events.publish("publisher.ping.v1", { n: 1 }, "publisher");
          return reply.code(204).send();
        });
      },
    };
    const flaky: BackendAppModule = {
      id: "flaky_events",
      async registerApi() {},
      async registerEvents(ctx) {
        // Subscribe first, THEN explode: the returned unsubscribe handles are
        // lost, so Core must reclaim by owner.
        ctx.events.subscribe("publisher.ping.v1", () => {
          received.push("leaked");
        });
        throw new Error("subscribe wiring exploded");
      },
    };

    await withFixturePlatform(
      {
        database: db,
        manifests: [
          { id: "publisher", yaml: capabilitiesYaml("publisher", ["events"]) },
          { id: "flaky_events", yaml: capabilitiesYaml("flaky_events", ["database", "events"]) },
        ],
        backendModules: { publisher, flaky_events: flaky },
      },
      async (platform) => {
        const list = await platform.app.inject({ method: "GET", url: "/api/core/apps" });
        const record = list.json().items.find((item: { id: string }) => item.id === "flaky_events");
        assert.equal(record.status, "error");
        assert.match(record.errorMessage, /registerEvents failed/);
        assert.equal(record.enabled, true, "intent stays enabled=true");

        // The subscription was reclaimed: a real publish reaches nobody, and
        // re-enabling (which retries and fails again) must not blow up either.
        const emit = await platform.app.inject({ method: "POST", url: "/api/apps/publisher/emit" });
        assert.equal(emit.statusCode, 204);
        const retry = await platform.app.inject({
          method: "PUT",
          url: "/api/core/apps/flaky_events/enabled",
          payload: { enabled: true },
        });
        assert.equal(retry.statusCode, 200);
        assert.equal(retry.json().status, "error");
        const emitAgain = await platform.app.inject({ method: "POST", url: "/api/apps/publisher/emit" });
        assert.equal(emitAgain.statusCode, 204);

        await new Promise((resolve) => setTimeout(resolve, 30));
        assert.equal(received.length, 0, "reclaimed subscription never fires");
      },
    );

    // A fresh platform with the healed app activates cleanly; the previous
    // run's reclaimed leftovers cause no duplicate subscription/id errors.
    const healed: BackendAppModule = {
      id: "flaky_events",
      async registerApi() {},
      async registerEvents(ctx) {
        ctx.events.subscribe("publisher.ping.v1", () => {
          received.push("healed");
        });
        return [];
      },
    };
    await withFixturePlatform(
      {
        database: db,
        manifests: [{ id: "flaky_events", yaml: capabilitiesYaml("flaky_events", ["database", "events"]) }],
        backendModules: { flaky_events: healed },
      },
      async (platform) => {
        const list = await platform.app.inject({ method: "GET", url: "/api/core/apps" });
        const record = list.json().items.find((item: { id: string }) => item.id === "flaky_events");
        assert.equal(record.status, "enabled", "clean retry after owner reclaim");
      },
    );
  });

  it("registerJobs that registers a job then throws stops the job", async () => {
    let runs = 0;
    const flaky: BackendAppModule = {
      id: "flaky_jobs",
      async registerApi() {},
      async registerJobs(ctx) {
        ctx.scheduler.register({
          id: "flaky_jobs.tick",
          schedule: { intervalMs: 20 },
          run: async () => {
            runs += 1;
          },
        });
        throw new Error("job wiring exploded");
      },
    };

    await withFixturePlatform(
      {
        database: db,
        manifests: [{ id: "flaky_jobs", yaml: capabilitiesYaml("flaky_jobs", ["database", "scheduler"]) }],
        backendModules: { flaky_jobs: flaky },
      },
      async (platform) => {
        const list = await platform.app.inject({ method: "GET", url: "/api/core/apps" });
        const record = list.json().items.find((item: { id: string }) => item.id === "flaky_jobs");
        assert.equal(record.status, "error");
        assert.match(record.errorMessage, /registerJobs failed/);

        // The half-registered job must have been reclaimed: it never runs.
        await new Promise((resolve) => setTimeout(resolve, 100));
        assert.equal(runs, 0, "half-registered job must not keep running");
      },
    );
  });

  it("disable→enable cycle on a broken app does not raise duplicate job ids", async () => {
    let attempts = 0;
    const flaky: BackendAppModule = {
      id: "flaky_cycle",
      async registerApi() {},
      async registerJobs(ctx) {
        attempts += 1;
        ctx.scheduler.register({
          id: "flaky_cycle.tick",
          schedule: { intervalMs: 20 },
          run: async () => undefined,
        });
        throw new Error("always broken");
      },
    };

    await withFixturePlatform(
      {
        database: db,
        manifests: [{ id: "flaky_cycle", yaml: capabilitiesYaml("flaky_cycle", ["database", "scheduler"]) }],
        backendModules: { flaky_cycle: flaky },
      },
      async (platform) => {
        for (let i = 0; i < 3; i += 1) {
          const off = await platform.app.inject({
            method: "PUT",
            url: "/api/core/apps/flaky_cycle/enabled",
            payload: { enabled: false },
          });
          assert.equal(off.json().status, "disabled");
          const on = await platform.app.inject({
            method: "PUT",
            url: "/api/core/apps/flaky_cycle/enabled",
            payload: { enabled: true },
          });
          assert.equal(on.json().status, "error", "activation keeps failing");
          assert.match(on.json().errorMessage, /registerJobs failed/);
        }
        assert.equal(attempts, 4, "startup + three enable cycles each retried registration");
      },
    );
  });
});

describe("capability enforcement (FP-9.5)", () => {
  async function activationError(
    platform: Platform,
    appId: string,
  ): Promise<{ status: string; errorMessage: string | undefined }> {
    const list = await platform.app.inject({ method: "GET", url: "/api/core/apps" });
    const record = list.json().items.find((item: { id: string }) => item.id === appId);
    return { status: record.status, errorMessage: record.errorMessage };
  }

  it("scheduler use without the scheduler capability fails activation with a capability error", async () => {
    const sneaky: BackendAppModule = {
      id: "sneaky_jobs",
      async registerApi() {},
      async registerJobs(ctx) {
        ctx.scheduler.register({ id: "sneaky_jobs.tick", schedule: { intervalMs: 1000 }, run: async () => undefined });
        return [];
      },
    };
    // Manifest declares database only — no scheduler grant.
    await withFixturePlatform(
      {
        database: db,
        manifests: [{ id: "sneaky_jobs", yaml: capabilitiesYaml("sneaky_jobs", ["database"]) }],
        backendModules: { sneaky_jobs: sneaky },
      },
      async (platform) => {
        const { status, errorMessage } = await activationError(platform, "sneaky_jobs");
        assert.equal(status, "error");
        assert.match(errorMessage ?? "", /capability 'scheduler' is not granted/);
      },
    );
  });

  it("event subscription without the events capability fails activation", async () => {
    const sneaky: BackendAppModule = {
      id: "sneaky_events",
      async registerApi() {},
      async registerEvents(ctx) {
        ctx.events.subscribe("sneaky_events.thing.v1", () => undefined);
        return [];
      },
    };
    await withFixturePlatform(
      {
        database: db,
        manifests: [{ id: "sneaky_events", yaml: capabilitiesYaml("sneaky_events", ["database"]) }],
        backendModules: { sneaky_events: sneaky },
      },
      async (platform) => {
        const { status, errorMessage } = await activationError(platform, "sneaky_events");
        assert.equal(status, "error");
        assert.match(errorMessage ?? "", /capability 'events' is not granted/);
      },
    );
  });

  it("database use without the database capability fails registerApi with a capability error", async () => {
    const sneaky: BackendAppModule = {
      id: "sneaky_db",
      async registerApi(ctx) {
        // Query during wiring so the violation surfaces at activation time.
        await ctx.database.query("SELECT 1");
        ctx.api.get("/data", async () => ({ ok: true }));
      },
    };
    await withFixturePlatform(
      {
        database: db,
        manifests: [{ id: "sneaky_db", yaml: capabilitiesYaml("sneaky_db", ["events"]) }],
        backendModules: { sneaky_db: sneaky },
      },
      async (platform) => {
        const { status, errorMessage } = await activationError(platform, "sneaky_db");
        assert.equal(status, "error");
        assert.match(errorMessage ?? "", /registerApi failed/);
        assert.match(errorMessage ?? "", /capability 'database' is not granted/);
      },
    );
  });

  it("storage use without the storage capability throws at request time", async () => {
    const sneaky: BackendAppModule = {
      id: "sneaky_storage",
      async registerApi(ctx) {
        ctx.api.get("/file", async () => {
          await ctx.storage.read("some/file.txt");
          return { ok: true };
        });
      },
    };
    await withFixturePlatform(
      {
        database: db,
        manifests: [{ id: "sneaky_storage", yaml: capabilitiesYaml("sneaky_storage", ["database"]) }],
        backendModules: { sneaky_storage: sneaky },
      },
      async (platform) => {
        // registerApi only wires routes (no storage touch), so the app is
        // enabled; the facade throws when the route actually uses storage.
        const list = await platform.app.inject({ method: "GET", url: "/api/core/apps" });
        const record = list.json().items.find((item: { id: string }) => item.id === "sneaky_storage");
        assert.equal(record.status, "enabled");

        const response = await platform.app.inject({ method: "GET", url: "/api/apps/sneaky_storage/file" });
        assert.equal(response.statusCode, 500);
        assert.match(response.json().error.message ?? "", /capability 'storage' is not granted/);
      },
    );
  });
});

describe("activation errors are persisted before the API reports them (FP-9.3)", () => {
  it("PUT enabled returning an error record implies core.apps already has it", async () => {
    const flaky: BackendAppModule = {
      id: "persist_err",
      async registerApi() {},
      async registerJobs() {
        throw new Error("persist me");
      },
    };
    await withFixturePlatform(
      {
        database: db,
        manifests: [{ id: "persist_err", yaml: capabilitiesYaml("persist_err", ["database", "scheduler"]) }],
        backendModules: { persist_err: flaky },
      },
      async (platform) => {
        // Startup activation failed; the API record and the database row must
        // already agree without any settle/wait.
        const list = await platform.app.inject({ method: "GET", url: "/api/core/apps" });
        const record = list.json().items.find((item: { id: string }) => item.id === "persist_err");
        assert.equal(record.status, "error");

        const row = await db
          .context()
          .query<{ enabled: boolean; status: string }>(
            "SELECT enabled, status FROM core.apps WHERE id = 'persist_err'",
          );
        assert.equal(row.rows[0]!.status, "error", "database row persisted at startup");
        assert.equal(row.rows[0]!.enabled, true, "intent preserved");
      },
    );
  });
});
