import { createHash, randomUUID } from "node:crypto";
import { AppError } from "../api/errors.js";
import { canonicalJson, contentBucket, MAX_INCREMENTAL_OBJECTS } from "./incremental.js";
import {
  TABLES, UUID, MAX_SNAPSHOT_BYTES, MAX_SNAPSHOT_ROWS, digest, exactKeys, keyOf, record,
  type Row, type Snapshot, type TableSpec,
} from "./snapshot-schema.js";
import { columnSignature, validateSyncPlan, type SyncFile } from "./sync-validate.js";
import type { Column } from "./snapshot-schema.js";

const HASH = /^[0-9a-f]{64}$/;

export interface SyncObjectRef {
  filename: string;
  sha256: string;
  size: number;
  kind: "rows" | "attachment" | "tombstones";
}

export interface SyncHead {
  type: "personal-platform-sync-head";
  formatVersion: 1;
  identityId: string;
  pairingVerifier: string;
  scope: "own";
  generation: number;
  opToken: string;
  parentOpToken: string | null;
  contentHash: string;
  schema: Record<string, string>;
  tables: Record<string, { bucket: number; object: SyncObjectRef }[]>;
  files: { attachmentId: string; object: SyncObjectRef }[];
  tombstones: SyncObjectRef;
}

export interface SyncDocument {
  head: SyncHead;
  objects: Map<string, { ref: SyncObjectRef; data: Buffer }>;
}

export function syncObjectName(identityId: string, sha256: string, kind: SyncObjectRef["kind"]): string {
  if (!UUID.test(identityId) || !HASH.test(sha256)) fail("Invalid sync object name.");
  const ext = kind === "attachment" ? "bin" : "json";
  return `pps-${identityId}-${sha256}.${ext}`;
}

export function syncHeadName(identityId: string): string {
  if (!UUID.test(identityId)) fail("Invalid sync identity.");
  return `pps-${identityId}-head.json`;
}

/**
 * Cloud rows use the sync identity as owner and omit replica-local fields.
 * `revision` and `storage_key` are replica-local and are omitted.
 * `updated_at` is authored metadata. It is not a merge clock (semantic hashes
 * exclude it) and is kept so a pull does not stamp arrival time.
 * Apply assigns a server storage key and a local revision.
 */
export function cloudRow(row: Row, table: TableSpec, identityId: string): Row {
  const copy: Row = {};
  for (const column of table.columns) {
    if (column === "user_id") copy.user_id = identityId;
    else if (column === "storage_key" || column === "revision") continue;
    else if (row[column] !== undefined) copy[column] = row[column];
  }
  return copy;
}

const LOCAL_ONLY = new Set(["storage_key", "revision"]);

/** Reject a full database row or a forged owner before any local field is filled in. */
export function assertCanonicalCloudRow(row: Row, table: TableSpec, identityId: string): void {
  for (const key of Object.keys(row)) {
    if (!table.columns.includes(key) || LOCAL_ONLY.has(key)) {
      throw new AppError(422, "invalid_sync", "Unexpected cloud field " + table.name + "." + key + ".");
    }
  }
  if (table.columns.includes("user_id") && row.user_id !== identityId) {
    throw new AppError(422, "invalid_sync", "Cloud row owner does not match the sync identity.");
  }
}

export function rehydrateCloudRow(row: Row, table: TableSpec, identityId: string): Row {
  assertCanonicalCloudRow(row, table, identityId);
  const copy: Row = { ...row };
  if (table.columns.includes("user_id")) copy.user_id = identityId;
  if (table.columns.includes("storage_key")) copy.storage_key = "sync/remote";
  if (table.columns.includes("revision")) copy.revision = 1;
  if (table.columns.includes("updated_at") && copy.updated_at === undefined) {
    copy.updated_at = typeof copy.created_at === "string" ? copy.created_at : "2026-01-01T00:00:00.000Z";
  }
  return copy;
}

/** Chunk rows the same way incremental backup does. One edit rewrites one bucket. */
export function buildSyncDocument(input: {
  snapshot: Snapshot;
  identityId: string;
  pairingVerifier: string;
  generation: number;
  opToken?: string;
  parentOpToken?: string | null;
  tombstones?: string[];
}): SyncDocument {
  if (input.snapshot.scope !== "own") fail("Sync documents are own-scope.");
  if (Object.keys(input.snapshot.tables).some(name => name.startsWith("core."))) fail("Sync does not carry core data.");
  const objects = new Map<string, { ref: SyncObjectRef; data: Buffer }>();
  const tables: SyncHead["tables"] = {};
  function add(data: Buffer, kind: SyncObjectRef["kind"]): SyncObjectRef {
    const sha256 = digest(data);
    const ref: SyncObjectRef = { filename: syncObjectName(input.identityId, sha256, kind), sha256, size: data.length, kind };
    objects.set(ref.filename, { ref, data });
    if (objects.size > MAX_INCREMENTAL_OBJECTS) fail("Sync document exceeds the 1024 content-object limit.");
    return ref;
  }
  for (const name of Object.keys(input.snapshot.tables).sort()) {
    const table = TABLES.find(item => item.name === name);
    if (!table) fail("Unsupported sync table " + name);
    const buckets = new Map<number, Row[]>();
    for (const row of input.snapshot.tables[name]!) {
      const stored = cloudRow(row, table, input.identityId);
      const bucket = contentBucket(stored, name);
      const list = buckets.get(bucket);
      if (list) list.push(stored);
      else buckets.set(bucket, [stored]);
    }
    tables[name] = [...buckets.entries()].sort(([a], [b]) => a - b).map(([bucket, rows]) => ({
      bucket,
      object: add(Buffer.from(canonicalJson(rows.sort((a, b) => keyOf(a, table.key) < keyOf(b, table.key) ? -1 : 1))), "rows"),
    }));
  }
  const files = [...input.snapshot.files].sort((a, b) => a.attachmentId < b.attachmentId ? -1 : 1).map(file => ({
    attachmentId: file.attachmentId,
    object: add(Buffer.from(file.data, "base64"), "attachment"),
  }));
  const tombstones = add(Buffer.from(canonicalJson([...new Set(input.tombstones ?? [])].sort())), "tombstones");
  const body = { schema: input.snapshot.schema, tables, files, tombstones };
  const head: SyncHead = {
    type: "personal-platform-sync-head", formatVersion: 1, identityId: input.identityId,
    pairingVerifier: input.pairingVerifier, scope: "own", generation: input.generation,
    opToken: input.opToken ?? randomUUID(), parentOpToken: input.parentOpToken ?? null,
    contentHash: createHash("sha256").update(canonicalJson(body)).digest("hex"),
    schema: input.snapshot.schema, tables, files, tombstones,
  };
  parseSyncHead(head, input.identityId);
  return { head, objects };
}

export function parseSyncHead(input: unknown, expectedIdentity?: string): SyncHead {
  if (!record(input)) fail("Invalid sync head.");
  let encoded = "";
  try { encoded = JSON.stringify(input); } catch { fail("Invalid sync head."); }
  if (Buffer.byteLength(encoded) > MAX_SNAPSHOT_BYTES) fail("Sync head exceeds the size limit.");
  keys(input, ["type", "formatVersion", "identityId", "pairingVerifier", "scope", "generation", "opToken", "parentOpToken", "contentHash", "schema", "tables", "files", "tombstones"], "sync head");
  if (input.type !== "personal-platform-sync-head" || input.formatVersion !== 1) fail("Unsupported sync head.");
  if (typeof input.identityId !== "string" || !UUID.test(input.identityId) || (expectedIdentity !== undefined && input.identityId !== expectedIdentity)) fail("Sync identity does not match.");
  if (typeof input.pairingVerifier !== "string" || !HASH.test(input.pairingVerifier)) fail("Invalid pairing verifier.");
  if (input.scope !== "own") fail("Sync documents are own-scope.");
  if (typeof input.generation !== "number" || !Number.isSafeInteger(input.generation) || input.generation < 0) fail("Invalid sync generation.");
  if (typeof input.opToken !== "string" || !UUID.test(input.opToken)) fail("Invalid sync operation.");
  if (input.parentOpToken !== null && (typeof input.parentOpToken !== "string" || !UUID.test(input.parentOpToken))) fail("Invalid sync parent.");
  if (typeof input.contentHash !== "string" || !HASH.test(input.contentHash)) fail("Invalid sync content hash.");
  if (!record(input.schema) || !record(input.tables) || !Array.isArray(input.files) || Array.isArray(input.tombstones) || !record(input.tombstones)) fail("Invalid sync head tables.");
  keys(input.schema, Object.keys(input.tables), "sync schema");
  const state = { count: 0, bytes: 0 };
  const seenNames = new Map<string, SyncObjectRef>();
  for (const name of Object.keys(input.tables)) {
    if (name.startsWith("core.") || !TABLES.some(table => table.name === name)) fail("Unsupported sync table " + name);
    if (typeof input.schema[name] !== "string" || !HASH.test(input.schema[name])) fail("Invalid schema fingerprint for " + name + ".");
    const buckets = input.tables[name];
    if (!Array.isArray(buckets) || buckets.length > 16) fail("Invalid sync bucket list.");
    const seen = new Set<number>();
    for (const entry of buckets) {
      if (!record(entry)) fail("Invalid row bucket.");
      keys(entry, ["bucket", "object"], "row bucket");
      if (typeof entry.bucket !== "number" || !Number.isSafeInteger(entry.bucket) || entry.bucket < 0 || entry.bucket > 15 || seen.has(entry.bucket)) fail("Invalid or duplicate row bucket.");
      seen.add(entry.bucket);
      remember(parseObjectRef(entry.object, "rows", input.identityId, state), seenNames);
    }
  }
  if (input.files.length > MAX_SNAPSHOT_ROWS) fail("Too many attachment references.");
  const attachmentIds = new Set<string>();
  for (const file of input.files) {
    if (!record(file)) fail("Invalid attachment reference.");
    keys(file, ["attachmentId", "object"], "sync attachment");
    if (typeof file.attachmentId !== "string" || !UUID.test(file.attachmentId) || attachmentIds.has(file.attachmentId)) fail("Invalid or duplicate attachment identity.");
    attachmentIds.add(file.attachmentId);
    remember(parseObjectRef(file.object, "attachment", input.identityId, state), seenNames);
  }
  remember(parseObjectRef(input.tombstones, "tombstones", input.identityId, state), seenNames);
  const head = input as unknown as SyncHead;
  const body = { schema: head.schema, tables: head.tables, files: head.files, tombstones: head.tombstones };
  if (createHash("sha256").update(canonicalJson(body)).digest("hex") !== head.contentHash) fail("Sync content hash does not match the head.");
  return head;
}

function parseObjectRef(value: unknown, kind: SyncObjectRef["kind"], identityId: string, state: { count: number; bytes: number }): SyncObjectRef {
  if (!record(value)) fail("Invalid sync object reference.");
  keys(value, ["filename", "sha256", "size", "kind"], "sync object reference");
  if (value.kind !== kind || typeof value.sha256 !== "string" || !HASH.test(value.sha256)) fail("Unexpected sync object type.");
  if (typeof value.filename !== "string" || value.filename !== syncObjectName(identityId, value.sha256, kind)) fail("Unsafe sync object reference.");
  if (typeof value.size !== "number" || !Number.isSafeInteger(value.size) || value.size < 0 || value.size > MAX_SNAPSHOT_BYTES) fail("Invalid sync object size.");
  state.count += 1;
  state.bytes += value.size;
  if (state.count > MAX_INCREMENTAL_OBJECTS) fail("Sync document exceeds the 1024 content-object limit.");
  if (state.bytes > MAX_SNAPSHOT_BYTES) fail("Sync content exceeds the size limit.");
  return { filename: value.filename, sha256: value.sha256, size: value.size, kind };
}

function remember(ref: SyncObjectRef, seen: Map<string, SyncObjectRef>): void {
  const old = seen.get(ref.filename);
  if (old && (old.sha256 !== ref.sha256 || old.size !== ref.size || old.kind !== ref.kind)) fail("Conflicting sync object references.");
  seen.set(ref.filename, ref);
}

function keys(value: Row, names: string[], label: string): void {
  try { exactKeys(value, names, label); }
  catch (error) {
    if (error instanceof AppError) fail(error.message);
    throw error;
  }
}

export function syncObjectRefs(head: SyncHead): SyncObjectRef[] {
  const refs = new Map<string, SyncObjectRef>();
  const listed = [
    ...Object.values(head.tables).flatMap(buckets => buckets.map(bucket => bucket.object)),
    ...head.files.map(file => file.object),
    head.tombstones,
  ];
  for (const ref of listed) {
    if (!ref || ref.filename !== syncObjectName(head.identityId, ref.sha256, ref.kind) || ref.size < 0 || ref.filename.includes("..")) fail("Unsafe sync object reference.");
    const old = refs.get(ref.filename);
    if (old && (old.sha256 !== ref.sha256 || old.size !== ref.size || old.kind !== ref.kind)) fail("Conflicting sync object references.");
    refs.set(ref.filename, ref);
  }
  return [...refs.values()];
}

export function changedObjectNames(previous: SyncDocument, next: SyncDocument): string[] {
  const before = new Set([...previous.objects.keys()]);
  return [...next.objects.keys()].filter(name => !before.has(name)).sort();
}

export interface ReconstructedSync {
  tables: Record<string, Row[]>;
  hashes: Map<string, string>;
  tombstones: string[];
  files: { attachmentId: string; sha256: string; data: string }[];
}

export async function reconstructSyncDocument(headInput: unknown, readObject: (ref: SyncObjectRef) => Promise<Buffer>, columns: ReadonlyMap<string, Column[]>, actorId: string): Promise<ReconstructedSync> {
  const head = parseSyncHead(headInput);
  const expectedSchema: Record<string, string> = {};
  for (const [name, definition] of columns) {
    if (name.startsWith("core.")) fail("Sync does not carry core data.");
    expectedSchema[name] = columnSignature(definition);
  }
  const headNames = Object.keys(head.schema).sort().join("|");
  const liveNames = Object.keys(expectedSchema).sort().join("|");
  if (headNames !== liveNames) fail("Sync table set does not match the local catalog.");
  for (const name of Object.keys(expectedSchema)) {
    if (head.schema[name] !== expectedSchema[name]) fail("Backup schema is incompatible with " + name + ".");
  }
  const tables: Record<string, Row[]> = {};
  let rowCount = 0;
  for (const [name, buckets] of Object.entries(head.tables)) {
    const spec = TABLES.find(table => table.name === name);
    if (!spec) fail("Unsupported sync table " + name);
    const rows: Row[] = [];
    for (const bucket of buckets) {
      const data = await readChecked(bucket.object, readObject);
      let decoded: unknown;
      try { decoded = JSON.parse(data.toString("utf8")); } catch { fail("Row content object is not valid JSON."); }
      if (!Array.isArray(decoded) || decoded.some(row => !record(row))) fail("Invalid row content object.");
      rowCount += decoded.length;
      if (rowCount > MAX_SNAPSHOT_ROWS) fail("Sync document exceeds the row limit.");
      for (const row of decoded as Row[]) {
        const hydrated = rehydrateCloudRow(row, spec, head.identityId);
        if (contentBucket(cloudRow(hydrated, spec, head.identityId), name) !== bucket.bucket) fail("Record is in the wrong content bucket.");
        rows.push(hydrated);
      }
    }
    tables[name] = rows;
  }
  const tombstoneBytes = await readChecked(head.tombstones, readObject);
  let decodedTombstones: unknown;
  try { decodedTombstones = JSON.parse(tombstoneBytes.toString("utf8")); } catch { fail("Tombstone object is not valid JSON."); }
  if (!Array.isArray(decodedTombstones)) fail("Invalid tombstone object.");
  if (decodedTombstones.length > MAX_SNAPSHOT_ROWS) fail("Sync document exceeds the tombstone limit.");
  const tombstones: string[] = [];
  const tombstoneSet = new Set<string>();
  for (const key of decodedTombstones) {
    if (typeof key !== "string" || !validSyncKey(key) || tombstoneSet.has(key)) fail("Invalid or duplicate tombstone key.");
    tombstoneSet.add(key);
    tombstones.push(key);
  }
  const live = new Set<string>();
  for (const [name, rows] of Object.entries(tables)) {
    for (const row of rows) {
      const key = syncKey(name, row);
      if (!validSyncKey(key) || live.has(key) || tombstoneSet.has(key)) fail("Remote head lists " + key + " as both live and deleted.");
      live.add(key);
    }
  }
  const files: SyncFile[] = [];
  for (const file of head.files) {
    const data = await readChecked(file.object, readObject);
    files.push({ attachmentId: file.attachmentId, sha256: file.object.sha256, size: data.length, data: data.toString("base64") });
  }
  const plan = validateSyncPlan({ actorId, remoteOwnerId: head.identityId, columns, schema: head.schema, expectedSchema, tables, files });
  return { tables: plan.tables, hashes: plan.hashes, tombstones, files: plan.files };
}

function syncKey(table: string, row: Row): string {
  const spec = TABLES.find(item => item.name === table);
  if (!spec) fail("Unsupported sync table " + table);
  return table + ":" + canonicalJson(spec.key.filter(key => key !== "user_id").map(key => row[key]));
}

export function validSyncKey(key: string): boolean {
  const split = key.indexOf(":");
  if (split < 1) return false;
  const table = key.slice(0, split);
  const spec = TABLES.find(item => item.name === table);
  if (!spec || table.startsWith("core.")) return false;
  let parts: unknown;
  try { parts = JSON.parse(key.slice(split + 1)); } catch { return false; }
  if (!Array.isArray(parts)) return false;
  const columns = spec.key.filter(column => column !== "user_id");
  if (parts.length !== columns.length) return false;
  for (let index = 0; index < columns.length; index++) {
    const column = columns[index]!;
    const value = parts[index];
    if (typeof value !== "string" || value.includes("\0")) return false;
    const uuid = column.endsWith("_id") || (column === "id" && !["clock.settings", "focus.settings", "mini_game.saves"].includes(table));
    if (uuid && !UUID.test(value)) return false;
  }
  return key === table + ":" + canonicalJson(parts);
}

async function readChecked(ref: SyncObjectRef, readObject: (ref: SyncObjectRef) => Promise<Buffer>): Promise<Buffer> {
  const data = await readObject(ref);
  if (!Buffer.isBuffer(data) || data.length !== ref.size || digest(data) !== ref.sha256) fail("Sync object size or SHA-256 differs from the head.");
  return data;
}

function fail(message: string): never {
  throw new AppError(422, "invalid_sync", message);
}
