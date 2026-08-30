import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { after, before, describe, it } from "node:test";
import { Database } from "../../src/core/database/index.js";
import notesApp from "../../src/apps/notes/index.js";
import type { Platform } from "../../src/core/platform.js";
import { buildFixturePlatform } from "../helpers/platform.js";
import { resetDatabase, TEST_DATABASE_URL } from "../helpers/db.js";
import { runMigrations } from "../../src/core/database/migrate.js";

/**
 * Notes app integration coverage (worklist PHASE7A1 §4, T05): CRUD with the
 * three-state PATCH, quick-note minimal create, tag get-or-create + tagIds
 * semantics, list filtering/search/sorting, dayKey/todayKey/yesterdayKey
 * across platform timezones (fixed clock, hot switch, DST) and the disabled
 * lifecycle. Assembly follows assets.test.ts; fixed clock follows
 * timezone.test.ts.
 */

const repoRoot = resolve(import.meta.dirname, "..", "..", "..");
const notesMigrations = [
  readFileSync(join(repoRoot, "apps/notes/migrations/20260830172735-init.sql"), "utf8"),
];

/**
 * Fixed clock at 16:00 UTC: under the default UTC platform timezone it is
 * still 2026-08-30, under Asia/Shanghai (UTC+8) it is already midnight of
 * 2026-08-31 — the day boundary the timezone suite pivots on.
 */
const FIXED_NOW = new Date("2026-08-30T16:00:00.000Z");
const FIXED_NOW_ISO = FIXED_NOW.toISOString();

interface NoteTagView {
  id: string;
  name: string;
}

interface NoteView {
  id: string;
  title: string | null;
  content: string;
  mood: string | null;
  occurredAt: string;
  pinned: boolean;
  createdAt: string;
  updatedAt: string;
  tags: NoteTagView[];
  dayKey: string;
}

interface TagView {
  id: string;
  name: string;
  createdAt: string;
}

interface NotesListBody {
  items: NoteView[];
  total: number;
  todayKey: string;
  yesterdayKey: string;
}

interface ErrorBody {
  error: { code: string; message: string };
}

let db: Database;
let platform: Platform;
let cleanup: () => void;
let root: string;

async function json<T>(
  method: "GET" | "POST" | "PATCH" | "PUT" | "DELETE",
  url: string,
  payload?: object,
): Promise<{ status: number; body: T }> {
  const response = await platform.app.inject({ method, url, payload });
  const raw = response.body;
  return { status: response.statusCode, body: (raw ? JSON.parse(raw) : null) as T };
}

async function createNote(body: object): Promise<NoteView> {
  const response = await json<NoteView>("POST", "/api/apps/notes/notes", body);
  assert.equal(response.status, 201, `fixture note created (${JSON.stringify(body)})`);
  return response.body;
}

async function createTag(name: string): Promise<TagView> {
  const response = await json<TagView>("POST", "/api/apps/notes/tags", { name });
  assert.equal(response.status, 201, `fixture tag "${name}" created`);
  return response.body;
}

async function noteById(id: string): Promise<{ status: number; body: NoteView }> {
  return json<NoteView>("GET", `/api/apps/notes/notes/${id}`);
}

/** PUT /api/core/settings/platform.timezone applies live (timezone.test.ts precedent). */
async function setTimezone(value: string): Promise<void> {
  const response = await json<{ value: string }>(
    "PUT",
    "/api/core/settings/platform.timezone",
    { value },
  );
  assert.equal(response.status, 200, `platform.timezone set to ${value}`);
}

/** The view boundary is camelCase (worklist §2.1): no snake_case key at any depth. */
function assertNoSnakeCaseKeys(value: unknown, path = "body"): void {
  if (Array.isArray(value)) {
    for (const [index, item] of value.entries()) {
      assertNoSnakeCaseKeys(item, `${path}[${index}]`);
    }
    return;
  }
  if (value && typeof value === "object") {
    for (const [key, child] of Object.entries(value)) {
      assert.ok(!key.includes("_"), `${path}.${key} must be camelCase (no snake_case keys)`);
      assertNoSnakeCaseKeys(child, `${path}.${key}`);
    }
  }
}

before(async () => {
  db = await resetDatabase();
  const fixture = await buildFixturePlatform({
    database: db,
    manifests: [{ id: "notes", migrations: notesMigrations }],
    backendModules: { notes: notesApp },
    clock: () => FIXED_NOW,
  });
  platform = fixture.platform;
  cleanup = fixture.cleanup;
  root = fixture.root;
  await runMigrations({
    databaseUrl: TEST_DATABASE_URL,
    targets: [{ scope: "notes", schema: "notes", dir: join(root, "apps", "notes", "migrations") }],
  });
});

after(async () => {
  // Setup may have failed partway; teardown must never turn that into a
  // secondary "cannot read properties of undefined" error.
  if (platform) await platform.stop();
  cleanup?.();
  if (db) await db.close();
});

describe("notes CRUD full path (P7A1-04)", () => {
  let tagAlpha: TagView;
  let tagBeta: TagView;
  let noteId: string;
  let created: NoteView;

  it("creates a fully populated note and returns a camelCase view", async () => {
    tagAlpha = await createTag("Link-Alpha");
    tagBeta = await createTag("Link-Beta");
    const response = await json<NoteView>("POST", "/api/apps/notes/notes", {
      title: "Full note",
      content: "body text",
      mood: "good",
      occurredAt: "2026-08-28T09:30:00Z",
      pinned: true,
      // Reversed order on purpose: embedded tags come back ordered by name.
      tagIds: [tagBeta.id, tagAlpha.id],
    });
    assert.equal(response.status, 201);
    created = response.body;
    noteId = created.id;
    assert.deepEqual(
      Object.keys(created).sort(),
      ["content", "createdAt", "dayKey", "id", "mood", "occurredAt", "pinned", "tags", "title", "updatedAt"],
    );
    assert.equal(created.title, "Full note");
    assert.equal(created.content, "body text");
    assert.equal(created.mood, "good");
    assert.equal(created.occurredAt, "2026-08-28T09:30:00.000Z");
    assert.equal(created.pinned, true);
    assert.deepEqual(created.tags, [
      { id: tagAlpha.id, name: "Link-Alpha" },
      { id: tagBeta.id, name: "Link-Beta" },
    ]);
    assert.equal(created.dayKey, "2026-08-28", "dayKey is the UTC local date of occurredAt");
    assert.ok(!Number.isNaN(Date.parse(created.createdAt)));
    assert.ok(!Number.isNaN(Date.parse(created.updatedAt)));
    assertNoSnakeCaseKeys(created);
  });

  it("fetches the note by id with the identical view", async () => {
    const fetched = await noteById(noteId);
    assert.equal(fetched.status, 200);
    assert.deepEqual(fetched.body, created);
  });

  it("PATCH: absent fields keep their current values", async () => {
    const response = await json<NoteView>("PATCH", `/api/apps/notes/notes/${noteId}`, {
      title: "Second draft",
    });
    assert.equal(response.status, 200);
    assert.equal(response.body.title, "Second draft");
    assert.equal(response.body.content, "body text", "absent content stays");
    assert.equal(response.body.mood, "good", "absent mood stays");
    assert.equal(response.body.pinned, true, "absent pinned stays");
    assert.equal(response.body.occurredAt, created.occurredAt, "absent occurredAt stays");
    assert.deepEqual(response.body.tags, created.tags, "absent tagIds keeps the links");
    assert.ok(response.body.updatedAt >= response.body.createdAt);
  });

  it("PATCH: explicit null clears nullable title and mood", async () => {
    const response = await json<NoteView>("PATCH", `/api/apps/notes/notes/${noteId}`, {
      title: null,
      mood: null,
    });
    assert.equal(response.status, 200);
    assert.equal(response.body.title, null, "title cleared");
    assert.equal(response.body.mood, null, "mood cleared");
  });

  it("PATCH: occurredAt null re-stamps with the platform clock", async () => {
    const response = await json<NoteView>("PATCH", `/api/apps/notes/notes/${noteId}`, {
      occurredAt: null,
    });
    assert.equal(response.status, 200);
    assert.equal(response.body.occurredAt, FIXED_NOW_ISO, "reset to ctx.time.now()");
    assert.equal(response.body.dayKey, "2026-08-30", "dayKey follows the re-stamp (UTC)");
  });

  it("PATCH: value updates apply and an empty object body returns the current view", async () => {
    const updated = await json<NoteView>("PATCH", `/api/apps/notes/notes/${noteId}`, {
      title: "Reopened",
      mood: "low",
      pinned: false,
    });
    assert.equal(updated.status, 200);
    assert.equal(updated.body.title, "Reopened");
    assert.equal(updated.body.mood, "low");
    assert.equal(updated.body.pinned, false);

    const snapshot = updated.body;
    const noop = await json<NoteView>("PATCH", `/api/apps/notes/notes/${noteId}`, {});
    assert.equal(noop.status, 200);
    assert.deepEqual(noop.body, snapshot, "empty body PATCH changes nothing");
  });

  it("PATCH: content updates apply; null content is a 400 (column is NOT NULL)", async () => {
    const updated = await json<NoteView>("PATCH", `/api/apps/notes/notes/${noteId}`, {
      content: "Revised body after the first capture.",
    });
    assert.equal(updated.status, 200);
    assert.equal(updated.body.content, "Revised body after the first capture.");

    const rejected = await json<ErrorBody>("PATCH", `/api/apps/notes/notes/${noteId}`, {
      content: null,
    });
    assert.equal(rejected.status, 400);
    assert.equal(rejected.body.error.code, "validation_error");

    const empty = await json<ErrorBody>("PATCH", `/api/apps/notes/notes/${noteId}`, {
      content: "",
    });
    assert.equal(empty.status, 400);
    assert.equal(empty.body.error.code, "validation_error");

    const kept = await noteById(noteId);
    assert.equal(kept.body.content, "Revised body after the first capture.");
  });

  it("deleting returns 204, cascades note_tags, keeps the tag row, and unknown ids 404", async () => {
    const tag = await createTag("Doomed-Link");
    const note = await createNote({ content: "delete me", tagIds: [tag.id] });

    const deleted = await json<null>("DELETE", `/api/apps/notes/notes/${note.id}`);
    assert.equal(deleted.status, 204);

    const gone = await noteById(note.id);
    assert.equal(gone.status, 404);
    assert.equal((gone.body as unknown as ErrorBody).error.code, "not_found");

    const links = await db.context().query("SELECT count(*)::int AS n FROM notes.note_tags WHERE note_id = $1", [note.id]);
    assert.equal(links.rows[0]!.n, 0, "note_tags rows cascade away with the note");

    const tags = await json<{ items: TagView[] }>("GET", "/api/apps/notes/tags");
    assert.ok(
      tags.body.items.some((item) => item.id === tag.id),
      "the tag itself survives its note's deletion",
    );

    const unknown = "77777777-7777-7777-7777-777777777777";
    assert.equal((await json<null>("PATCH", `/api/apps/notes/notes/${unknown}`, { title: "x" })).status, 404);
    assert.equal((await json<null>("DELETE", `/api/apps/notes/notes/${unknown}`)).status, 404);
    assert.equal((await noteById(unknown)).status, 404);
  });
});

describe("list response shape and quick note minimal create (P7A1-05/09)", () => {
  it("lists {items,total,todayKey,yesterdayKey} in camelCase with UTC day keys", async () => {
    const response = await json<NotesListBody>("GET", "/api/apps/notes/notes");
    assert.equal(response.status, 200);
    assert.deepEqual(Object.keys(response.body).sort(), ["items", "todayKey", "total", "yesterdayKey"]);
    assert.ok(Array.isArray(response.body.items));
    assert.equal(response.body.todayKey, "2026-08-30", "fixed clock, UTC platform timezone");
    assert.equal(response.body.yesterdayKey, "2026-08-29");
    assertNoSnakeCaseKeys(response.body);
  });

  it("quick note: POST with only {content} defaults everything from the platform clock", async () => {
    const response = await json<NoteView>("POST", "/api/apps/notes/notes", {
      content: "quick capture",
    });
    assert.equal(response.status, 201);
    assert.equal(response.body.title, null);
    assert.equal(response.body.mood, null);
    assert.equal(response.body.pinned, false);
    assert.deepEqual(response.body.tags, []);
    assert.equal(response.body.occurredAt, FIXED_NOW_ISO, "occurredAt defaults to ctx.time.now() exactly");
    assert.equal(response.body.dayKey, "2026-08-30");

    // Persistence on the same platform: a second read finds the row.
    const listed = await json<NotesListBody>("GET", "/api/apps/notes/notes?q=quick%20capture");
    assert.equal(listed.body.total, 1);
    assert.equal(listed.body.items[0]!.id, response.body.id);
  });
});

describe("mood validation (P7A1-04)", () => {
  it("rejects an unknown mood with 400 validation_error on create and update", async () => {
    const badCreate = await json<ErrorBody>("POST", "/api/apps/notes/notes", {
      content: "mood probe",
      mood: "ecstatic",
    });
    assert.equal(badCreate.status, 400);
    assert.equal(badCreate.body.error.code, "validation_error");

    const note = await createNote({ content: "mood patch target" });
    const badPatch = await json<ErrorBody>("PATCH", `/api/apps/notes/notes/${note.id}`, {
      mood: "angry",
    });
    assert.equal(badPatch.status, 400);
    assert.equal(badPatch.body.error.code, "validation_error");
  });
});

describe("tag lifecycle: get-or-create, trim, delete (P7A1-08)", () => {
  it("creates a trimmed name with 201 and upserts to the same id with 200", async () => {
    const created = await json<TagView>("POST", "/api/apps/notes/tags", { name: "  Workflow  " });
    assert.equal(created.status, 201);
    assert.equal(created.body.name, "Workflow", "name is trimmed");
    assert.deepEqual(Object.keys(created.body).sort(), ["createdAt", "id", "name"]);
    assertNoSnakeCaseKeys(created.body);

    const again = await json<TagView>("POST", "/api/apps/notes/tags", { name: "Workflow" });
    assert.equal(again.status, 200, "existing name is a 200 get-or-create");
    assert.equal(again.body.id, created.body.id, "same tag id, no duplicate row");
    assert.equal(again.body.name, "Workflow");
  });

  it("rejects names that are empty after trimming or over 50 chars with 400", async () => {
    const blank = await json<ErrorBody>("POST", "/api/apps/notes/tags", { name: "   " });
    assert.equal(blank.status, 400);
    assert.equal(blank.body.error.code, "validation_error");

    const tooLong = await json<ErrorBody>("POST", "/api/apps/notes/tags", {
      name: "x".repeat(51),
    });
    assert.equal(tooLong.status, 400);
    assert.equal(tooLong.body.error.code, "validation_error");
  });

  it("deleting a tag unlinks its notes but keeps the notes themselves", async () => {
    const tag = await createTag("Unlink-Me");
    const note = await createNote({
      title: "Keeps existing",
      content: "tag delete target",
      tagIds: [tag.id],
    });

    const deleted = await json<null>("DELETE", `/api/apps/notes/tags/${tag.id}`);
    assert.equal(deleted.status, 204);

    const after = await noteById(note.id);
    assert.equal(after.status, 200, "the note survives the tag deletion");
    assert.equal(after.body.title, "Keeps existing");
    assert.deepEqual(after.body.tags, [], "only the link is gone");

    const tags = await json<{ items: TagView[] }>("GET", "/api/apps/notes/tags");
    assert.ok(!tags.body.items.some((item) => item.id === tag.id));

    const unknown = await json<null>("DELETE", "/api/apps/notes/tags/88888888-8888-8888-8888-888888888888");
    assert.equal(unknown.status, 404);
  });

  it("lists tags ordered by name", async () => {
    await createTag("Zebra-Last");
    await createTag("Aardvark-First");
    const response = await json<{ items: TagView[] }>("GET", "/api/apps/notes/tags");
    assert.equal(response.status, 200);
    assertNoSnakeCaseKeys(response.body);
    const names = response.body.items.map((tag) => tag.name);
    for (const [index, name] of names.entries()) {
      if (index > 0) assert.ok(names[index - 1]! <= name, `tags sorted by name (${names[index - 1]} <= ${name})`);
    }
    assert.ok(names.indexOf("Aardvark-First") < names.indexOf("Zebra-Last"));
  });
});

describe("note tagIds semantics (P7A1-08)", () => {
  let tagA: TagView;
  let tagB: TagView;
  let tagC: TagView;

  before(async () => {
    tagA = await createTag("Set-Alpha");
    tagB = await createTag("Set-Beta");
    tagC = await createTag("Set-Gamma");
  });

  it("attaches multiple tags on create and silently dedupes repeated ids", async () => {
    const note = await createNote({
      content: "multi tag",
      tagIds: [tagA.id, tagB.id, tagA.id, tagB.id],
    });
    assert.deepEqual(note.tags, [
      { id: tagA.id, name: "Set-Alpha" },
      { id: tagB.id, name: "Set-Beta" },
    ]);
  });

  it("rejects non-uuid tagIds with 400 validation_error", async () => {
    const response = await json<ErrorBody>("POST", "/api/apps/notes/notes", {
      content: "bad uuid tag",
      tagIds: ["not-a-uuid"],
    });
    assert.equal(response.status, 400);
    assert.equal(response.body.error.code, "validation_error");
  });

  it("rejects unknown tag ids with 422 tag_not_found and rolls the create back", async () => {
    const response = await json<ErrorBody>("POST", "/api/apps/notes/notes", {
      content: "txn-create-rollback",
      tagIds: ["99999999-9999-9999-9999-999999999999"],
    });
    assert.equal(response.status, 422);
    assert.equal(response.body.error.code, "tag_not_found");

    const rows = await db
      .context()
      .query("SELECT count(*)::int AS n FROM notes.notes WHERE content = 'txn-create-rollback'");
    assert.equal(rows.rows[0]!.n, 0, "the note insert was rolled back with the failed link");
  });

  it("PATCH tagIds replaces the set wholesale; [] clears and absent keeps", async () => {
    const note = await createNote({ content: "replace tags", tagIds: [tagA.id, tagB.id] });

    const replaced = await json<NoteView>("PATCH", `/api/apps/notes/notes/${note.id}`, {
      tagIds: [tagC.id],
    });
    assert.equal(replaced.status, 200);
    assert.deepEqual(replaced.body.tags, [{ id: tagC.id, name: "Set-Gamma" }]);

    const untouched = await json<NoteView>("PATCH", `/api/apps/notes/notes/${note.id}`, {
      title: "tags unchanged",
    });
    assert.deepEqual(untouched.body.tags, [{ id: tagC.id, name: "Set-Gamma" }], "absent tagIds keeps the links");

    const cleared = await json<NoteView>("PATCH", `/api/apps/notes/notes/${note.id}`, { tagIds: [] });
    assert.equal(cleared.status, 200);
    assert.deepEqual(cleared.body.tags, [], "empty array clears the whole set");
  });

  it("PATCH tagIds:null is a 400 (use [] to clear)", async () => {
    const note = await createNote({ content: "null tagIds probe", tagIds: [tagA.id] });
    const response = await json<ErrorBody>("PATCH", `/api/apps/notes/notes/${note.id}`, {
      tagIds: null,
    });
    assert.equal(response.status, 400);
    assert.equal(response.body.error.code, "validation_error");
  });

  it("PATCH with an unknown tag id fails atomically: the field change is not persisted", async () => {
    const note = await createNote({ title: "before-txn", content: "patch rollback" });
    const response = await json<ErrorBody>("PATCH", `/api/apps/notes/notes/${note.id}`, {
      title: "after-txn",
      tagIds: ["aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa"],
    });
    assert.equal(response.status, 422);
    assert.equal(response.body.error.code, "tag_not_found");

    const after = await noteById(note.id);
    assert.equal(after.body.title, "before-txn", "field update rolled back with the failed link");
  });
});

describe("list filters, search and sorting (P7A1-05)", () => {
  let alpha: TagView;
  let beta: TagView;
  let gamma: TagView;

  before(async () => {
    alpha = await createTag("Filter-Alpha");
    beta = await createTag("Filter-Beta");
    gamma = await createTag("Filter-Gamma");
    const needleTag = await createTag("tagneedle");

    // All list fixtures carry the "fltnote" marker so q isolates this suite.
    await createNote({
      title: "fltnote Report",
      content: "fltnote quarterly numbers",
      mood: "great",
      pinned: true,
      occurredAt: "2026-04-10T12:00:00Z",
      tagIds: [alpha.id, beta.id],
    });
    await createNote({
      title: "fltnote Idea",
      content: "fltnote sketch",
      mood: "low",
      pinned: false,
      occurredAt: "2026-04-11T12:00:00Z",
      tagIds: [alpha.id],
    });
    await createNote({
      title: "fltnote Log",
      content: "fltnote entry",
      mood: "neutral",
      pinned: true,
      occurredAt: "2026-04-12T12:00:00Z",
      tagIds: [beta.id, gamma.id],
    });
    // Exact local-day boundaries (UTC platform timezone).
    await createNote({ title: "fltnote Edge Start", content: "fltnote", occurredAt: "2026-04-11T00:00:00.000Z" });
    await createNote({ title: "fltnote Edge End", content: "fltnote", occurredAt: "2026-04-12T23:59:59.999Z" });

    // One hit per q surface (title / content / tag name) plus a miss.
    await createNote({ title: "titleneedle in the title", content: "plain words", occurredAt: "2026-04-13T10:00:00Z" });
    await createNote({ title: "plain heading", content: "contentneedle in the body", occurredAt: "2026-04-14T10:00:00Z" });
    await createNote({ title: "plain tagged", content: "plain body", tagIds: [needleTag.id], occurredAt: "2026-04-15T10:00:00Z" });

    // Sort fixtures: distinct occurred_at plus a same-timestamp pair created
    // back to back (created_at decides the tie).
    await createNote({ title: "sortnote A", content: "sortnote", occurredAt: "2026-05-01T09:00:00Z" });
    await createNote({ title: "sortnote B", content: "sortnote", occurredAt: "2026-05-03T09:00:00Z" });
    await createNote({ title: "sortnote C", content: "sortnote", occurredAt: "2026-05-02T09:00:00Z" });
    await createNote({ title: "sortnote D1", content: "sortnote", occurredAt: "2026-05-04T09:00:00Z" });
    await createNote({ title: "sortnote D2", content: "sortnote", occurredAt: "2026-05-04T09:00:00Z" });
  });

  /** Titles of the "fltnote" fixtures (all titled; null would show through). */
  async function fltnoteTitles(query: string): Promise<string[]> {
    const response = await json<NotesListBody>("GET", `/api/apps/notes/notes?q=fltnote&${query}`);
    assert.equal(response.status, 200);
    return response.body.items.map((note) => note.title ?? "(untitled)");
  }

  it("filters by multiple tags with AND semantics", async () => {
    const both = await json<NotesListBody>(
      "GET",
      `/api/apps/notes/notes?q=fltnote&tags=${alpha.id},${beta.id}`,
    );
    assert.equal(both.status, 200);
    assert.deepEqual(
      both.body.items.map((note) => note.title),
      ["fltnote Report"],
      "only the note carrying both tags matches",
    );

    const single = await json<NotesListBody>("GET", `/api/apps/notes/notes?q=fltnote&tags=${alpha.id}`);
    assert.deepEqual(
      [...single.body.items.map((note) => note.title)].sort(),
      ["fltnote Idea", "fltnote Report"],
      "a single tag widens the result",
    );
    assert.equal(single.body.total, 2);
  });

  it("filters by mood", async () => {
    assert.deepEqual(await fltnoteTitles("mood=low"), ["fltnote Idea"]);
    assert.deepEqual(await fltnoteTitles("mood=great"), ["fltnote Report"]);
  });

  it("filters by pinned true and false", async () => {
    assert.deepEqual((await fltnoteTitles("pinned=true")).sort(), ["fltnote Log", "fltnote Report"]);
    assert.deepEqual(
      (await fltnoteTitles("pinned=false")).sort(),
      ["fltnote Edge End", "fltnote Edge Start", "fltnote Idea"],
    );
  });

  it("filters occurredFrom/occurredTo inclusively on the platform-local date", async () => {
    const titles = await fltnoteTitles("occurredFrom=2026-04-11&occurredTo=2026-04-12");
    assert.deepEqual([...titles].sort(), [
      "fltnote Edge End",
      "fltnote Edge Start",
      "fltnote Idea",
      "fltnote Log",
    ], "both boundary instants are included; 2026-04-10 is not");

    const total = await json<NotesListBody>(
      "GET",
      "/api/apps/notes/notes?q=fltnote&occurredFrom=2026-04-11&occurredTo=2026-04-12",
    );
    assert.equal(total.body.total, 4);

    const fromOnly = await fltnoteTitles("occurredFrom=2026-04-12");
    assert.deepEqual([...fromOnly].sort(), ["fltnote Edge End", "fltnote Log"]);
  });

  it("q search hits title, content and tag names, and misses cleanly", async () => {
    const byTitle = await json<NotesListBody>("GET", "/api/apps/notes/notes?q=titleneedle");
    assert.deepEqual(
      byTitle.body.items.map((note) => note.title),
      ["titleneedle in the title"],
    );

    const byContent = await json<NotesListBody>("GET", "/api/apps/notes/notes?q=contentneedle");
    assert.deepEqual(
      byContent.body.items.map((note) => note.title),
      ["plain heading"],
    );

    const byTagName = await json<NotesListBody>("GET", "/api/apps/notes/notes?q=tagneedle");
    assert.deepEqual(
      byTagName.body.items.map((note) => note.title),
      ["plain tagged"],
      "q matches through the note's tag name",
    );

    const miss = await json<NotesListBody>("GET", "/api/apps/notes/notes?q=zznomatchzz");
    assert.deepEqual(miss.body.items, []);
    assert.equal(miss.body.total, 0);
  });

  it("sorts by occurred_at DESC with created_at DESC as the tie-break by default", async () => {
    const response = await json<NotesListBody>("GET", "/api/apps/notes/notes?q=sortnote");
    assert.deepEqual(
      response.body.items.map((note) => note.title),
      ["sortnote D2", "sortnote D1", "sortnote B", "sortnote C", "sortnote A"],
      "same occurred_at pair ordered by created_at DESC, then descending occurred_at",
    );
  });

  it("sorts by createdAt ascending via the allowlist", async () => {
    const response = await json<NotesListBody>(
      "GET",
      "/api/apps/notes/notes?q=sortnote&sortBy=createdAt&order=asc",
    );
    assert.deepEqual(
      response.body.items.map((note) => note.title),
      ["sortnote A", "sortnote B", "sortnote C", "sortnote D1", "sortnote D2"],
      "creation order",
    );
  });

  it("rejects unknown sortBy and order values with 400", async () => {
    const badSort = await json<ErrorBody>("GET", "/api/apps/notes/notes?sortBy=bogus");
    assert.equal(badSort.status, 400);
    assert.equal(badSort.body.error.code, "validation_error");

    const badOrder = await json<ErrorBody>("GET", "/api/apps/notes/notes?order=sideways");
    assert.equal(badOrder.status, 400);
  });

  it("reports total for the full filtered set with items capped at 500", async () => {
    const filtered = await json<NotesListBody>("GET", "/api/apps/notes/notes?q=fltnote");
    assert.equal(filtered.body.total, 5);
    assert.equal(filtered.body.items.length, 5);

    const all = await json<NotesListBody>("GET", "/api/apps/notes/notes");
    assert.equal(all.body.total, all.body.items.length, "total equals the full set size");
    assert.ok(all.body.items.length >= 5);
    assert.ok(all.body.items.length <= 500, "hard server-side cap is 500");
  });
});

describe("dayKey across timezones, day boundaries and DST (P7A1-05, fixed clock)", () => {
  it("UTC: notes on either side of the day boundary land in different dayKey groups", async () => {
    const before = await createNote({ content: "utcside-before", occurredAt: "2026-06-09T23:59:00.000Z" });
    const after = await createNote({ content: "utcside-after", occurredAt: "2026-06-10T00:01:00.000Z" });
    assert.equal(before.dayKey, "2026-06-09");
    assert.equal(after.dayKey, "2026-06-10");

    const list = await json<NotesListBody>("GET", "/api/apps/notes/notes");
    assert.equal(list.body.todayKey, "2026-08-30");
    assert.equal(list.body.yesterdayKey, "2026-08-29");
  });

  it("Asia/Shanghai: a 16:00Z capture is already the next local day", async () => {
    await setTimezone("Asia/Shanghai");
    try {
      const note = await createNote({ content: "shanghai-late-evening", occurredAt: FIXED_NOW_ISO });
      assert.equal(note.dayKey, "2026-08-31", "16:00Z is 2026-08-31 00:00 in Shanghai");

      const single = await noteById(note.id);
      assert.equal(single.body.dayKey, "2026-08-31");

      const list = await json<NotesListBody>("GET", "/api/apps/notes/notes?q=shanghai-late-evening");
      assert.equal(list.body.todayKey, "2026-08-31");
      assert.equal(list.body.yesterdayKey, "2026-08-30");
      assert.equal(list.body.items[0]!.dayKey, "2026-08-31");
    } finally {
      await setTimezone("UTC");
    }
  });

  it("hot-switching the platform timezone moves dayKey/todayKey/yesterdayKey live", async () => {
    // Created under UTC: 16:00Z belongs to 2026-08-30 there.
    const note = await createNote({ content: "tzswap-note", occurredAt: FIXED_NOW_ISO });
    assert.equal(note.dayKey, "2026-08-30");

    await setTimezone("Asia/Shanghai");
    try {
      const shanghai = await json<NotesListBody>("GET", "/api/apps/notes/notes?q=tzswap-note");
      assert.equal(shanghai.body.items[0]!.dayKey, "2026-08-31");
      assert.equal(shanghai.body.todayKey, "2026-08-31");
      assert.equal(shanghai.body.yesterdayKey, "2026-08-30");

      await setTimezone("UTC");
      const utc = await json<NotesListBody>("GET", "/api/apps/notes/notes?q=tzswap-note");
      assert.equal(utc.body.items[0]!.dayKey, "2026-08-30");
      assert.equal(utc.body.todayKey, "2026-08-30");
      assert.equal(utc.body.yesterdayKey, "2026-08-29");
    } finally {
      await setTimezone("UTC");
    }
  });

  it("America/New_York spring-forward day (2026-03-08) groups by local date", async () => {
    await setTimezone("America/New_York");
    try {
      // Around the 02:00 EST -> 03:00 EDT jump at 2026-03-08T07:00Z.
      const fixtures: Array<{ at: string; dayKey: string; label: string }> = [
        { at: "2026-03-08T03:59:00.000Z", dayKey: "2026-03-07", label: "s0 before local midnight" },
        { at: "2026-03-08T05:01:00.000Z", dayKey: "2026-03-08", label: "s1 first hour EST" },
        { at: "2026-03-08T06:30:00.000Z", dayKey: "2026-03-08", label: "s2 before the jump (01:30 EST)" },
        { at: "2026-03-08T07:30:00.000Z", dayKey: "2026-03-08", label: "s3 after the jump (03:30 EDT)" },
        { at: "2026-03-09T03:59:00.000Z", dayKey: "2026-03-08", label: "s4 last minute (23:59 EDT)" },
        { at: "2026-03-09T04:00:00.000Z", dayKey: "2026-03-09", label: "s5 next local midnight" },
      ];
      const created: NoteView[] = [];
      for (const fixture of fixtures) {
        created.push(await createNote({ content: `dstspring ${fixture.label}`, occurredAt: fixture.at }));
      }
      for (const [index, note] of created.entries()) {
        assert.equal(note.dayKey, fixtures[index]!.dayKey, `${fixtures[index]!.label} -> ${fixtures[index]!.dayKey}`);
      }

      // occurredFrom/To shares the dayKey caliber: the skipped hour never
      // leaks a note across the local date.
      const day = await json<NotesListBody>(
        "GET",
        "/api/apps/notes/notes?q=dstspring&occurredFrom=2026-03-08&occurredTo=2026-03-08",
      );
      assert.equal(day.body.total, 4, "exactly the four 2026-03-08-local notes (s1..s4)");
      assert.ok(day.body.items.every((note) => note.dayKey === "2026-03-08"));
    } finally {
      await setTimezone("UTC");
    }
  });

  it("America/New_York fall-back day (2026-11-01) groups by local date", async () => {
    await setTimezone("America/New_York");
    try {
      // Around the 02:00 EDT -> 01:00 EST jump at 2026-11-01T06:00Z: the
      // 25-hour day keeps both 01:30 instants on the same local date.
      const fixtures: Array<{ at: string; dayKey: string; label: string }> = [
        { at: "2026-11-01T03:59:00.000Z", dayKey: "2026-10-31", label: "f0 before local midnight" },
        { at: "2026-11-01T04:01:00.000Z", dayKey: "2026-11-01", label: "f1 first hour EDT" },
        { at: "2026-11-01T05:30:00.000Z", dayKey: "2026-11-01", label: "f2 01:30 EDT" },
        { at: "2026-11-01T06:30:00.000Z", dayKey: "2026-11-01", label: "f3 01:30 EST (repeated hour)" },
        { at: "2026-11-02T04:59:00.000Z", dayKey: "2026-11-01", label: "f4 last minute (23:59 EST)" },
        { at: "2026-11-02T05:00:00.000Z", dayKey: "2026-11-02", label: "f5 next local midnight" },
      ];
      for (const fixture of fixtures) {
        const note = await createNote({ content: `dstfall ${fixture.label}`, occurredAt: fixture.at });
        assert.equal(note.dayKey, fixture.dayKey, `${fixture.label} -> ${fixture.dayKey}`);
      }

      const day = await json<NotesListBody>(
        "GET",
        "/api/apps/notes/notes?q=dstfall&occurredFrom=2026-11-01&occurredTo=2026-11-01",
      );
      assert.equal(day.body.total, 4, "exactly the four 2026-11-01-local notes (f1..f4)");
      assert.ok(day.body.items.every((note) => note.dayKey === "2026-11-01"));
    } finally {
      await setTimezone("UTC");
    }
  });
});

describe("disabled lifecycle and persistence (P7A1-12)", () => {
  it("disabling the notes app turns every route into 404 while keeping the data", async () => {
    const note = await createNote({ title: "Lifecycle", content: "lifecycle-note" });
    await createTag("Lifecycle-Tag");

    const disabled = await json<{ status: string }>("PUT", "/api/core/apps/notes/enabled", {
      enabled: false,
    });
    assert.equal(disabled.status, 200);
    assert.equal(disabled.body.status, "disabled");

    const probes: Array<["GET" | "POST" | "PATCH" | "DELETE", string, object?]> = [
      ["GET", "/api/apps/notes/notes"],
      ["POST", "/api/apps/notes/notes", { content: "while-disabled" }],
      ["GET", `/api/apps/notes/notes/${note.id}`],
      ["PATCH", `/api/apps/notes/notes/${note.id}`, { title: "nope" }],
      ["DELETE", `/api/apps/notes/notes/${note.id}`],
      ["GET", "/api/apps/notes/tags"],
      ["POST", "/api/apps/notes/tags", { name: "nope" }],
      ["DELETE", "/api/apps/notes/tags/00000000-0000-0000-0000-000000000000"],
    ];
    for (const [method, url, payload] of probes) {
      const probe = await json<ErrorBody>(method, url, payload);
      assert.equal(probe.status, 404, `${method} ${url} is 404 while the app is disabled`);
      assert.equal(probe.body.error.code, "not_found");
    }

    const rows = await db
      .context()
      .query("SELECT count(*)::int AS n FROM notes.notes WHERE id = $1", [note.id]);
    assert.equal(rows.rows[0]!.n, 1, "disable never touches the schema or rows");
  });

  it("re-enabling restores the routes with the data intact", async () => {
    const enabled = await json<{ status: string }>("PUT", "/api/core/apps/notes/enabled", {
      enabled: true,
    });
    assert.equal(enabled.status, 200);
    assert.equal(enabled.body.status, "enabled");

    const list = await json<NotesListBody>("GET", "/api/apps/notes/notes?q=lifecycle-note");
    assert.equal(list.status, 200);
    assert.equal(list.body.total, 1);
    assert.equal(list.body.items[0]!.title, "Lifecycle");

    const single = await noteById(list.body.items[0]!.id);
    assert.equal(single.status, 200);
    assert.equal(single.body.content, "lifecycle-note");

    const tags = await json<{ items: TagView[] }>("GET", "/api/apps/notes/tags");
    assert.ok(tags.body.items.some((tag) => tag.name === "Lifecycle-Tag"));
  });
});
