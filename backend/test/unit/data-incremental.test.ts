import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import {
  buildIncremental, canonicalJson, fingerprintManifest, getObjectRefs, parseManifest, reconstructManifest,
  type IncrementalManifest, type IncrementalPlan,
} from "../../src/core/data-management/incremental.js";
import { digest, keyOf, TABLES, type Snapshot, type Row } from "../../src/core/data-management/snapshot-schema.js";

const owner = randomUUID();
const namespace = digest(Buffer.from("test owner / destination / scope"));
const at = "2026-11-01T00:00:00.000Z";
function snapshot(count = 2): Snapshot {
  const tasks = Array.from({ length: count }, (_, index) => ({
    id: randomUUID(), title: `Task ${index}`, description: null, status: "todo", due_at: null,
    completed_at: null, created_at: at, updated_at: at, start_at: null, priority: 1, user_id: owner,
  })).sort((a, b) => a.id.localeCompare(b.id));
  return { type: "personal-platform-data", formatVersion: 1, createdAt: at, scope: "own", source: { id: owner, username: "test-owner" }, schema: { "tasks.tasks": digest(Buffer.from("tasks-schema")) }, tables: { "tasks.tasks": tasks }, files: [] };
}
function attachment(input: Snapshot, data: Buffer): void {
  const item = { id: randomUUID(), name: "asset", description: null, quantity: 1, acquired_at: "2026-11-01", created_at: at, updated_at: at, target_location: null, user_id: owner };
  const file = { id: randomUUID(), item_id: item.id, filename: "binary.dat", content_type: "application/octet-stream", size: data.length, storage_key: `original/${randomUUID()}`, created_at: at, user_id: owner };
  (input.tables["assets.items"] ??= []).push(item);
  (input.tables["assets.attachments"] ??= []).push(file);
  input.schema["assets.items"] = digest(Buffer.from("items-schema"));
  input.schema["assets.attachments"] = digest(Buffer.from("attachments-schema"));
  input.files.push({ attachmentId: file.id, sha256: digest(data), data: data.toString("base64") });
}
function normalized(input: Snapshot): Snapshot {
  const output = structuredClone(input);
  for (const [table, rows] of Object.entries(output.tables)) {
    const key = TABLES.find(spec => spec.name === table)!.key;
    rows.sort((a, b) => keyOf(a, key).localeCompare(keyOf(b, key)));
  }
  output.files.sort((a, b) => a.attachmentId.localeCompare(b.attachmentId));
  return output;
}
async function restore(plan: IncrementalPlan): Promise<Snapshot> {
  return reconstructManifest(plan.manifest, async ref => plan.objects.get(ref.filename)!.data);
}

test("full-reference manifests round-trip binary files and preserve table/date/JSON null values", async () => {
  const input = snapshot();
  attachment(input, Buffer.from([0, 255, 17, 192, 0]));
  input.tables["clock.settings"] = [{ id: "current", user_id: owner, value: null, updated_at: at }];
  input.schema["clock.settings"] = digest(Buffer.from("clock-schema"));
  const plan = buildIncremental(input, namespace);
  assert.deepEqual(await restore(plan), normalized(input));
  assert.equal(plan.logicalSize, Buffer.byteLength(JSON.stringify(input)));
  assert.deepEqual(parseManifest(plan.manifestBytes, namespace), plan.manifest);
});

test("fingerprints ignore creation time and object insertion order but capture changed rows", async () => {
  const input = snapshot(64);
  const first = buildIncremental(input, namespace);
  const reordered = structuredClone(input);
  reordered.createdAt = "2026-11-02T00:00:00.000Z";
  reordered.tables["tasks.tasks"]!.reverse();
  reordered.tables["tasks.tasks"] = reordered.tables["tasks.tasks"]!.map(row => Object.fromEntries(Object.entries(row).reverse()));
  const same = buildIncremental(reordered, namespace);
  assert.equal(same.fingerprint, first.fingerprint);
  assert.deepEqual([...same.objects.keys()], [...first.objects.keys()]);
  assert.notDeepEqual(same.manifestBytes, first.manifestBytes);
  reordered.tables["tasks.tasks"]![0]!.title = "edited";
  const changed = buildIncremental(reordered, namespace);
  const newObjects = [...changed.objects.keys()].filter(name => !first.objects.has(name));
  assert.equal(newObjects.length, 1, "one row edit uploads only its stable bucket");
  assert.notEqual(changed.fingerprint, first.fingerprint);
  assert.deepEqual(await restore(changed), normalized(reordered));
});

test("row insertions and deletions reconstruct exact independent historical states", async () => {
  const old = snapshot(35);
  const first = buildIncremental(old, namespace);
  const next = structuredClone(old);
  next.tables["tasks.tasks"]!.splice(3, 1);
  next.tables["tasks.tasks"]!.push(snapshot(1).tables["tasks.tasks"]![0]!);
  const second = buildIncremental(next, namespace);
  const objects = new Map([...first.objects, ...second.objects]);
  assert.deepEqual(await reconstructManifest(first.manifest, async ref => objects.get(ref.filename)!.data), normalized(old));
  assert.deepEqual(await reconstructManifest(second.manifest, async ref => objects.get(ref.filename)!.data), normalized(next));
  assert.equal((await restore(second)).tables["tasks.tasks"]!.length, 35);
});

test("identical attachments share one raw object and removed/readded files retain old restore points", async () => {
  const input = snapshot();
  const bytes = Buffer.from("shared content 数据");
  attachment(input, bytes); attachment(input, bytes);
  const first = buildIncremental(input, namespace);
  assert.equal(getObjectRefs(first.manifest).filter(ref => ref.kind === "attachment").length, 1);
  let attachmentReads = 0;
  await reconstructManifest(first.manifest, async ref => { if (ref.kind === "attachment") attachmentReads++; return first.objects.get(ref.filename)!.data; });
  assert.equal(attachmentReads, 1);
  const next = structuredClone(input);
  next.files.pop(); next.tables["assets.attachments"]!.pop();
  const removed = buildIncremental(next, namespace);
  assert.equal(removed.manifest.files.length, 1);
  assert.deepEqual(await restore(removed), normalized(next));
  assert.equal(buildIncremental(input, namespace).fingerprint, first.fingerprint);
});

test("namespaces bind every content filename and unsafe/unknown/duplicate references are rejected", () => {
  const plan = buildIncremental(snapshot(), namespace);
  const other = buildIncremental(snapshot(), digest(Buffer.from("another connection")));
  assert.notEqual(plan.manifest.namespace, other.manifest.namespace);
  assert.throws(() => parseManifest(plan.manifestBytes, other.manifest.namespace), /namespace/);
  assert.throws(() => parseManifest({ ...plan.manifest, surprise: true }), /fields/);
  const bad = structuredClone(plan.manifest);
  bad.tables["tasks.tasks"]![0]!.object.filename = "../outside";
  assert.throws(() => parseManifest(bad), /Unsafe filename/);
  const duplicate = structuredClone(plan.manifest);
  duplicate.tables["tasks.tasks"]!.push(duplicate.tables["tasks.tasks"]![0]!);
  assert.throws(() => parseManifest(duplicate), /duplicate row bucket/);
  assert.throws(() => parseManifest({ ...plan.manifest, schema: {} }), /fields/);
});

test("same-size corruption, wrong bucket, duplicate rows and foreign ownership fail reconstruction", async () => {
  const plan = buildIncremental(snapshot(1), namespace);
  await assert.rejects(reconstructManifest(plan.manifest, async ref => Buffer.alloc(ref.size)), /SHA-256/);
  const wrongBucket = structuredClone(plan.manifest);
  wrongBucket.tables["tasks.tasks"]![0]!.bucket = (wrongBucket.tables["tasks.tasks"]![0]!.bucket + 1) % 16;
  await assert.rejects(reconstructManifest(wrongBucket, async ref => plan.objects.get(ref.filename)!.data), /wrong content bucket/);
  async function changedRows(modify: (rows: Row[]) => void) {
    const changed = structuredClone(plan.manifest);
    const entry = changed.tables["tasks.tasks"]![0]!;
    const rows = JSON.parse(plan.objects.get(entry.object.filename)!.data.toString()) as Row[];
    modify(rows);
    const data = Buffer.from(canonicalJson(rows)); const sha = digest(data);
    entry.object = { filename: `ppc-${namespace}-${sha}.json`, sha256: sha, size: data.length, kind: "rows" };
    return reconstructManifest(changed, async () => data);
  }
  await assert.rejects(changedRows(rows => rows.push(rows[0]!)), /Duplicate primary key/);
  await assert.rejects(changedRows(rows => { rows[0]!.user_id = randomUUID(); }), /more than one owner/);
});

test("source relationship and attachment metadata checks run before creating a plan", () => {
  const input = snapshot(); attachment(input, Buffer.from("abc"));
  const bad = structuredClone(input); bad.tables["assets.attachments"]![0]!.item_id = randomUUID();
  assert.throws(() => buildIncremental(bad, namespace), /Missing parent/);
  const wrongSize = structuredClone(input); wrongSize.tables["assets.attachments"]![0]!.size = 100;
  assert.throws(() => buildIncremental(wrongSize, namespace), /Attachment size/);
});

test("reference totals and object count fail before attempting network reads", async () => {
  const input = snapshot(); attachment(input, Buffer.from("abc"));
  const plan = buildIncremental(input, namespace);
  const oversized = structuredClone(plan.manifest);
  oversized.files[0]!.object.size = 32 * 1024 * 1024;
  await assert.rejects(reconstructManifest(oversized, async () => { throw new Error("must not read"); }), /cumulative size/);
  const many = structuredClone(plan.manifest);
  many.files = Array.from({ length: 1025 }, (_, index) => {
    const sha256 = digest(Buffer.from(String(index)));
    return { attachmentId: randomUUID(), object: { filename: `ppc-${namespace}-${sha256}.bin`, sha256, size: 0, kind: "attachment" as const } };
  });
  assert.throws(() => parseManifest(many), /1024 content-object/);
  const amplified = structuredClone(plan.manifest);
  const shared = { ...amplified.files[0]!.object, size: 1024 * 1024 };
  amplified.files = Array.from({ length: 30 }, () => ({ attachmentId: randomUUID(), object: shared }));
  await assert.rejects(reconstructManifest(amplified, async () => { throw new Error("must not read amplified content"); }), /expanded 32 MiB/);
});

test("offline CLI reconstructs without a database, protects output, and rejects linked/missing objects", async () => {
  const root = await mkdtemp(join(tmpdir(), "pp-incremental-cli-"));
  const objects = join(root, "objects"); await mkdir(objects);
  const input = snapshot(); attachment(input, Buffer.from("offline binary"));
  const plan = buildIncremental(input, namespace);
  const manifestPath = join(root, "downloaded-manifest.json");
  await writeFile(manifestPath, plan.manifestBytes);
  for (const [name, object] of plan.objects) await writeFile(join(objects, name), object.data);
  const output = join(root, "restored.json");
  const script = resolve(import.meta.dirname, "../../../scripts/reconstruct-backup.ts");
  const run = (objectDirectory = objects, outputFile = output) => spawnSync(process.execPath, ["--import", "tsx", script, "--manifest", manifestPath, "--objects", objectDirectory, "--output", outputFile], { encoding: "utf8", timeout: 10_000 });
  try {
    const first = run(); assert.equal(first.status, 0, first.stderr);
    assert.deepEqual(JSON.parse(await readFile(output, "utf8")), normalized(input));
    assert.equal((await stat(output)).mode & 0o777, 0o600);
    assert.notEqual(run().status, 0, "existing output must not be overwritten");
    const linked = join(root, "linked"); await symlink(objects, linked);
    assert.notEqual(run(linked, join(root, "linked-output.json")).status, 0);
    const object = [...plan.objects.values()][0]!;
    const path = join(objects, object.ref.filename); await rm(path);
    assert.notEqual(run(objects, join(root, "missing-output.json")).status, 0);
    const outside = join(root, "outside"); await writeFile(outside, object.data); await symlink(outside, path);
    assert.notEqual(run(objects, join(root, "symlink-output.json")).status, 0);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("offline CLI rejects FIFO inputs without waiting for a writer or creating output", async () => {
  const root = await mkdtemp(join(tmpdir(), "pp-incremental-fifo-"));
  const objects = join(root, "objects"); await mkdir(objects);
  const plan = buildIncremental(snapshot(1), namespace);
  const manifest = join(root, "manifest.json"), output = join(root, "full.json");
  const script = resolve(import.meta.dirname, "../../../scripts/reconstruct-backup.ts");
  const fifo = (path: string) => assert.equal(spawnSync("mkfifo", [path]).status, 0);
  const run = () => spawnSync(process.execPath, ["--import", "tsx", script, "--manifest", manifest, "--objects", objects, "--output", output], { encoding: "utf8", timeout: 2000 });
  try {
    fifo(manifest);
    const invalidManifest = run();
    assert.equal(invalidManifest.status, 1, "FIFO manifest must reject, not hang until timeout");
    assert.match(invalidManifest.stderr, /regular file/);
    await rm(manifest); await writeFile(manifest, plan.manifestBytes);
    fifo(join(objects, [...plan.objects.keys()][0]!));
    const invalidObject = run();
    assert.equal(invalidObject.status, 1, "FIFO object must reject, not hang until timeout");
    assert.match(invalidObject.stderr, /regular file/);
    await assert.rejects(stat(output), { code: "ENOENT" });
  } finally { await rm(root, { recursive: true, force: true }); }
});
