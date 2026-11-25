import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { after, before, describe, it } from "node:test";
import assets from "../../src/apps/assets/index.js";
import notes from "../../src/apps/notes/index.js";
import type { AgentScope } from "../../src/core/agent/types.js";
import type { Database } from "../../src/core/database/index.js";
import { runMigrations } from "../../src/core/database/migrate.js";
import type { Platform } from "../../src/core/platform.js";
import { resetDatabase, TEST_DATABASE_URL } from "../helpers/db.js";
import { multipartBody } from "../helpers/multipart.js";
import { buildFixturePlatform, createTestUser, ensureTestAdmin, loginCookie } from "../helpers/platform.js";

const repo = resolve(import.meta.dirname, "../../..");
let db: Database;
let platform: Platform;
let cleanup: () => void;
let cookie: string;
let otherCookie: string;

async function agent(allowedApps: string[], scopes: AgentScope[] = ["read", "write", "delete"]): Promise<string> {
  const created = await platform.app.inject({
    method: "POST", url: "/api/core/agents", headers: { cookie }, payload: { name: "App tools", allowedApps, scopes },
  });
  assert.equal(created.statusCode, 201, created.body);
  return created.json<{ token: string }>().token;
}

function invoke(token: string, tool: string, payload: object = {}) {
  return platform.app.inject({
    method: "POST", url: `/api/agent/v1/tools/${tool}`, headers: { authorization: `Bearer ${token}` }, payload,
  });
}

function mcpTool(token: string, id: string, name: string, args: object, task?: { ttl: number }) {
  return platform.app.inject({
    method: "POST", url: "/api/agent/mcp",
    headers: {
      authorization: `Bearer ${token}`, accept: "application/json, text/event-stream",
      "content-type": "application/json", "mcp-protocol-version": "2025-11-25",
    },
    payload: { jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: args, task } },
  });
}

async function result<T>(token: string, tool: string, payload?: object): Promise<T> {
  const response = await invoke(token, tool, payload);
  assert.equal(response.statusCode, 200, response.body);
  const { ok, data } = response.json<{ ok: boolean; data: T }>();
  assert.equal(ok, true);
  return data;
}

async function summary<T>(token: string, appId: "notes" | "assets"): Promise<T> {
  const uri = encodeURIComponent(`pp://apps/${appId}/summary`);
  const response = await platform.app.inject({
    method: "GET", url: `/api/agent/v1/resources?uri=${uri}`, headers: { authorization: `Bearer ${token}` },
  });
  assert.equal(response.statusCode, 200, response.body);
  return JSON.parse(response.json<{ text: string }>().text) as T;
}

async function restoreAgentTrash(originalId: string): Promise<string> {
  const listed = await platform.app.inject({ method: "GET", url: "/api/core/trash", headers: { cookie } });
  assert.equal(listed.statusCode, 200, listed.body);
  const entry = listed.json<{ items: { id: string; entityId: string; deletedByType: string; deletedByLabel: string }[] }>()
    .items.find((entry) => entry.entityId === originalId);
  assert.ok(entry);
  assert.equal(entry.deletedByType, "agent");
  assert.equal(entry.deletedByLabel, "App tools");
  const restored = await platform.app.inject({ method: "POST", url: `/api/core/trash/${entry.id}/restore`, headers: { cookie } });
  assert.equal(restored.statusCode, 200, restored.body);
  const { restoredId } = restored.json<{ restoredId: string }>();
  assert.notEqual(restoredId, originalId);
  return restoredId;
}

describe("Notes and Assets Agent tool App boundaries", () => {
  before(async () => {
    db = await resetDatabase();
    await ensureTestAdmin(db);
    const other = await createTestUser(db, "agent-app-other");
    const appIds = ["notes", "assets"];
    await runMigrations({ databaseUrl: TEST_DATABASE_URL, targets: appIds.map((id) => ({
      scope: id, schema: id, dir: join(repo, "apps", id, "migrations"),
    })) });
    const manifests = await Promise.all(appIds.map(async (id) => ({ id, yaml: await readFile(join(repo, "apps", id, "app.yaml"), "utf8") })));
    const fixture = await buildFixturePlatform({ database: db, manifests, backendModules: { notes, assets } });
    platform = fixture.platform;
    cleanup = fixture.cleanup;
    cookie = await loginCookie(platform);
    otherCookie = await loginCookie(platform, other.username, "test-password-agent-app-other");
  });

  after(async () => {
    await platform?.stop();
    cleanup?.();
    await db?.close();
  });

  it("projects and filters Notes, preserves create replay and returns the locked current note on stale edits", async () => {
    const token = await agent(["notes"]);
    const idempotencyKey = randomUUID();
    const content = "Markdown ".repeat(30);
    const tagged = await platform.app.inject({
      method: "POST", url: "/api/apps/notes/tags", headers: { cookie }, payload: { name: "Agent context" },
    });
    assert.equal(tagged.statusCode, 201, tagged.body);
    const tagIds: string[] = [tagged.json().id];
    const created = await result<{ id: string }>(token, "notes_create", { content, idempotencyKey, tagIds });
    assert.deepEqual(Object.keys(created), ["id"]);
    assert.deepEqual(await result(token, "notes_create", {
      content, idempotencyKey, title: null, mood: null, occurredAt: null, pinned: false, tagIds,
    }), created);
    const foreign = await platform.app.inject({
      method: "POST", url: "/api/apps/notes/notes", headers: { cookie: otherCookie }, payload: { content: "Other user's notes" },
    });
    assert.equal(foreign.statusCode, 201, foreign.body);
    assert.equal((await invoke(token, "notes_get", { id: foreign.json().id })).statusCode, 404);
    const listed = await result<{ items: Record<string, unknown>[] }>(token, "notes_list", { q: "Markdown", tag: "Agent context", limit: 1 });
    assert.equal(listed.items.length, 1);
    assert.equal(listed.items[0]?.snippet, content.slice(0, 160));
    assert.ok(!("content" in listed.items[0]!));
    assert.deepEqual((await result<{ items: { id: string }[] }>(token, "notes_tags_list")).items.map((tag) => tag.id), tagIds);
    assert.equal((await summary<{ total: number }>(token, "notes")).total, 1);
    assert.ok("notes" in await result<Record<string, unknown>>(token, "platform_overview"));
    const full = await result<{ id: string; content: string; baseHash: string }>(token, "notes_get", { id: created.id });
    assert.equal(full.content, content);

    const updated = await platform.app.inject({
      method: "PATCH", url: `/api/apps/notes/notes/${created.id}`, headers: { cookie },
      payload: { title: "Changed in browser" },
    });
    assert.equal(updated.statusCode, 200, updated.body);
    const stale = await invoke(token, "notes_update", { id: created.id, baseHash: full.baseHash, title: "Stale overwrite" });
    assert.equal(stale.statusCode, 409, stale.body);
    const error = stale.json().error;
    assert.equal(error.code, "conflict");
    assert.equal(error.details.current.title, "Changed in browser");
    assert.equal(error.details.current.baseHash, updated.json().baseHash);
    assert.equal((await invoke(token, "notes_update", { id: created.id, title: "Missing proof" })).statusCode, 422);
    const saved = await result<{ baseHash: string; title: string | null }>(token, "notes_update", {
      id: created.id, baseHash: error.details.current.baseHash, title: null,
    });
    assert.equal(saved.title, null);
    await result(token, "notes_delete", { id: created.id, baseHash: saved.baseHash });
    const newId = await restoreAgentTrash(created.id);
    assert.equal((await result<{ content: string }>(token, "notes_get", { id: newId })).content, content);
  });

  it("lists Assets metadata, rejects write-only reference probes and restores agent-deleted attachments", async () => {
    const token = await agent(["assets"]);
    const writeOnly = await agent(["assets"], ["write", "delete"]);
    const createViaAgent = { name: "Agent asset", idempotencyKey: randomUUID() };
    assert.equal((await invoke(writeOnly, "assets_create", createViaAgent)).statusCode, 403);
    const { id } = await result<{ id: string }>(token, "assets_create", createViaAgent);
    const url = `/api/apps/assets/items/${id}`;
    const uploadedFile = multipartBody([{ name: "file", filename: "document.bin", contentType: "application/octet-stream", data: "bytes omitted by Agent get" }]);
    const uploaded = await platform.app.inject({
      method: "POST", url: `${url}/attachments`, headers: { cookie, ...uploadedFile.headers }, payload: uploadedFile.payload,
    });
    assert.equal(uploaded.statusCode, 201, uploaded.body);
    const initial = await result<{ baseHash: string; attachments: unknown[] }>(token, "assets_get", { id });
    assert.deepEqual(initial.attachments, [{
      id: uploaded.json().id, filename: "document.bin", contentType: "application/octet-stream", size: 26,
    }]);
    const projected = await result<{ items: { id: string }[] }>(token, "assets_list", { q: "Agent asset" });
    assert.deepEqual(projected.items.map((item) => item.id), [id]);
    const categories = await result<{ items: unknown[] }>(token, "assets_categories_list");
    assert.ok(Array.isArray(categories.items));
    assert.equal((await summary<{ items: number }>(token, "assets")).items, 1);
    assert.ok("assets" in await result<Record<string, unknown>>(token, "platform_overview"));

    const edited = await platform.app.inject({ method: "PATCH", url, headers: { cookie }, payload: { quantity: 3 } });
    assert.equal(edited.statusCode, 200, edited.body);
    const stale = await invoke(token, "assets_delete", { id, baseHash: initial.baseHash });
    assert.equal(stale.statusCode, 409, stale.body);
    const current = stale.json().error.details.current;
    assert.equal(stale.json().error.code, "conflict");
    assert.equal(current.quantity, 3);
    assert.equal(current.baseHash, edited.json().baseHash);
    assert.equal((await invoke(writeOnly, "assets_delete", { id, baseHash: current.baseHash })).statusCode, 403);
    await result(token, "assets_delete", { id, baseHash: current.baseHash });
    const restoredId = await restoreAgentTrash(id);
    const restored = await result<{ quantity: number; attachments: { id: string; filename: string }[] }>(token, "assets_get", { id: restoredId });
    assert.equal(restored.quantity, 3);
    assert.notEqual(restored.attachments[0]?.id, uploaded.json().id);
    const download = await platform.app.inject({
      method: "GET", url: `/api/apps/assets/items/${restoredId}/attachments/${restored.attachments[0]?.id}`, headers: { cookie },
    });
    assert.equal(download.statusCode, 200, download.body);
    assert.equal(download.body, "bytes omitted by Agent get");
  });

  it("rejects task-augmented Assets creation without creating an asset or a receipt", async () => {
    const token = await agent(["assets"]);
    const name = "Unsupported MCP task " + randomUUID();
    const idempotencyKey = randomUUID();
    const id = "assets-task";
    const response = await mcpTool(token, id, "assets_create", { name, idempotencyKey }, { ttl: 60_000 });
    assert.equal(response.statusCode, 200, response.body);
    assert.match(response.headers["content-type"] ?? "", /^application\/json/);
    const rpc = response.json();
    assert.equal(rpc.id, id);
    assert.match(rpc.error.message, /does not support task creation/);
    assert.equal(rpc.result, undefined);
    assert.equal((await db.query("SELECT 1 FROM assets.items WHERE name = $1", [name])).rowCount, 0);
    assert.equal((await db.query("SELECT 1 FROM core.agent_create_receipts WHERE idempotency_key = $1", [idempotencyKey])).rowCount, 0);
  });

  it("returns authorized Assets proof and schema errors as MCP tool results correlated to their requests", async () => {
    const token = await agent(["assets"]);
    const { id } = await result<{ id: string }>(token, "assets_create", {
      name: "MCP current proof", idempotencyKey: randomUUID(),
    });
    const { baseHash } = await result<{ baseHash: string }>(token, "assets_get", { id });
    const edited = await platform.app.inject({
      method: "PATCH", url: `/api/apps/assets/items/${id}`, headers: { cookie }, payload: { quantity: 4 },
    });
    assert.equal(edited.statusCode, 200, edited.body);
    const newHash = edited.json().baseHash;

    for (const [requestId, args, status, code] of [
      ["stale-delete", { id, baseHash }, 409, "conflict"],
      ["bad-delete", { id }, 422, "invalid_arguments"],
    ] as const) {
      const json = await invoke(token, "assets_delete", args);
      assert.equal(json.statusCode, status, json.body);
      assert.equal(json.json().error.code, code);
      const response = await mcpTool(token, requestId, "assets_delete", args);
      assert.equal(response.statusCode, 200, response.body);
      assert.match(response.headers["content-type"] ?? "", /^text\/event-stream/);
      const data = response.body.split(/\r?\n/).find((line) => line.startsWith("data: "));
      assert.ok(data, response.body);
      const rpc = JSON.parse(data.slice("data: ".length));
      assert.equal(rpc.jsonrpc, "2.0");
      assert.equal(rpc.id, requestId);
      assert.equal(rpc.error, undefined);
      assert.equal(rpc.result.isError, true);
      assert.deepEqual(rpc.result.structuredContent, json.json());
      assert.deepEqual(JSON.parse(rpc.result.content[0].text), rpc.result.structuredContent);
      if (code === "conflict") {
        assert.equal(rpc.result.structuredContent.error.details.current.quantity, 4);
        assert.equal(rpc.result.structuredContent.error.details.current.baseHash, newHash);
        assert.match(rpc.result.structuredContent.error.details.retryHint, /retry/);
      }
    }
    assert.equal((await result<{ baseHash: string }>(token, "assets_get", { id })).baseHash, newHash);
  });

  it("rolls back an Agent Assets delete and keeps original bytes when the success audit fails", async () => {
    const token = await agent(["assets"]);
    const { id: itemId } = await result<{ id: string }>(token, "assets_create", {
      name: "Assets audit failure", idempotencyKey: randomUUID(),
    });
    const url = `/api/apps/assets/items/${itemId}`;
    const bytes = Buffer.from([0, 2, 100, 128, 255, 0]);
    const file = multipartBody([{ name: "file", filename: "audit-test.bin", contentType: "application/octet-stream", data: bytes }]);
    const upload = await platform.app.inject({
      method: "POST", url: `${url}/attachments`, headers: { cookie, ...file.headers }, payload: file.payload,
    });
    assert.equal(upload.statusCode, 201, upload.body);
    const { id: attachmentId } = upload.json<{ id: string }>();
    const { baseHash } = await result<{ baseHash: string }>(token, "assets_get", { id: itemId });
    const original = await db.query<{ storage_key: string; user_id: string }>(
      "SELECT storage_key, user_id FROM assets.attachments WHERE id = $1", [attachmentId],
    );
    const agentId = (await db.query<{ id: string }>("SELECT id FROM core.agents WHERE token_hash = $1",
      [createHash("sha256").update(token).digest("hex")])).rows[0]!.id;

    // A sequence observation survives transaction rollback and proves the
    // successful audit was attempted after the archive and live deletion.
    await db.query("CREATE SEQUENCE core.test_assets_audit_observation");
    await db.query(`
      CREATE FUNCTION core.fail_test_assets_delete_audit() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF NEW.tool_name = 'assets_delete' AND NEW.status = 'ok' THEN
          IF EXISTS (SELECT 1 FROM assets.items WHERE id::text = NEW.resource_id AND user_id = NEW.user_id)
            OR EXISTS (SELECT 1 FROM assets.attachments WHERE item_id::text = NEW.resource_id AND user_id = NEW.user_id)
            OR NOT EXISTS (
              SELECT 1 FROM core.trash_items WHERE entity_id::text = NEW.resource_id AND user_id = NEW.user_id
                AND app_id = 'assets' AND deleted_by_agent_id = NEW.agent_id AND jsonb_array_length(attachment_keys) = 1
            ) THEN
            RAISE EXCEPTION 'test audit ran before the asset and attachment were archived';
          END IF;
          PERFORM nextval('core.test_assets_audit_observation');
          RAISE EXCEPTION 'injected success audit failure';
        END IF;
        RETURN NEW;
      END $$`);
    await db.query(`
      CREATE TRIGGER fail_test_assets_delete_audit BEFORE INSERT ON core.agent_audit_logs
      FOR EACH ROW EXECUTE FUNCTION core.fail_test_assets_delete_audit()`);
    try {
      const rejected = await invoke(token, "assets_delete", { id: itemId, baseHash });
      assert.equal(rejected.statusCode, 500, rejected.body);
      assert.deepEqual((await db.query("SELECT is_called FROM core.test_assets_audit_observation")).rows, [{ is_called: true }]);
      assert.equal((await db.query("SELECT id FROM assets.items WHERE id = $1", [itemId])).rowCount, 1);
      assert.deepEqual((await db.query("SELECT storage_key, user_id FROM assets.attachments WHERE id = $1 AND item_id = $2",
        [attachmentId, itemId])).rows, original.rows);
      const originalDownload = await platform.app.inject({
        method: "GET", url: `${url}/attachments/${attachmentId}`, headers: { cookie },
      });
      assert.equal(originalDownload.statusCode, 200, originalDownload.body);
      assert.deepEqual(originalDownload.rawPayload, bytes);
      assert.equal((await db.query("SELECT id FROM core.trash_items WHERE entity_id = $1", [itemId])).rowCount, 0);
      const audits = await db.query("SELECT status FROM core.agent_audit_logs WHERE agent_id = $1 AND tool_name = 'assets_delete'", [agentId]);
      assert.deepEqual(audits.rows, [{ status: "error" }]);
      const intents = await db.query(`
        SELECT committed_at FROM core.trash_blob_intents WHERE user_id = $1
          AND operation = 'delete' AND files @> jsonb_build_array(jsonb_build_object('attachmentId', $2::text))`,
      [original.rows[0]!.user_id, attachmentId]);
      assert.deepEqual(intents.rows, [{ committed_at: null }]);
    } finally {
      await db.query("DROP TRIGGER fail_test_assets_delete_audit ON core.agent_audit_logs");
      await db.query("DROP FUNCTION core.fail_test_assets_delete_audit()");
      await db.query("DROP SEQUENCE core.test_assets_audit_observation");
    }

    // The original proof still works because the failed transaction changed no live state.
    await result(token, "assets_delete", { id: itemId, baseHash });
    assert.equal((await db.query(`
      SELECT id FROM core.agent_audit_logs WHERE agent_id = $1 AND tool_name = 'assets_delete' AND status = 'ok'`, [agentId])).rowCount, 1);
    assert.equal((await db.query("SELECT id FROM core.trash_items WHERE entity_id = $1", [itemId])).rowCount, 1);
  });
});
