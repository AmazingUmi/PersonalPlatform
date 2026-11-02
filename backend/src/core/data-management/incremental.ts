import { AppError } from "../api/errors.js";
import { assertRecordGraph } from "./record-graph.js";
import {
  TABLES, UUID, MAX_SNAPSHOT_BYTES, MAX_SNAPSHOT_ROWS, digest, exactKeys,
  keyOf, record, validTimestamp, validateEnvelope,
  type Snapshot, type Row, type Scope,
} from "./snapshot-schema.js";

export const MAX_INCREMENTAL_OBJECTS = 1024;
const HASH = /^[0-9a-f]{64}$/;
const compareText = (a: string, b: string): number => a < b ? -1 : a > b ? 1 : 0;
export interface ObjectRef { filename: string; sha256: string; size: number; kind: "rows" | "attachment" }
export interface IncrementalManifest {
  type: "personal-platform-incremental";
  formatVersion: 1;
  namespace: string;
  createdAt: string;
  scope: Scope;
  source: Snapshot["source"];
  schema: Record<string, string>;
  tables: Record<string, { bucket: number; object: ObjectRef }[]>;
  files: { attachmentId: string; object: ObjectRef }[];
}
export interface IncrementalPlan {
  manifest: IncrementalManifest;
  manifestBytes: Buffer;
  objects: Map<string, { ref: ObjectRef; data: Buffer }>;
  fingerprint: string;
  logicalSize: number;
}
function invalid(message: string, status = 422): never {
  throw new AppError(status, "invalid_incremental_backup", message);
}

/** Stable bytes independent of source object insertion order. Array order is significant. */
export function canonicalJson(value: unknown): string {
  function normalize(input: unknown, depth: number): unknown {
    if (depth > 128) invalid("Backup JSON nesting exceeds the supported depth.");
    if (input === null || typeof input === "string" || typeof input === "boolean") return input;
    if (typeof input === "number" && Number.isFinite(input)) return input;
    if (Array.isArray(input)) return input.map(item => normalize(item, depth + 1));
    if (record(input)) return Object.fromEntries(Object.keys(input).sort().map(key => [key, normalize(input[key], depth + 1)]));
    invalid("Backup contains a non-JSON value.");
  }
  return JSON.stringify(normalize(value, 0));
}

/** Stable 16-way partition. One edited row rewrites only its bucket. */
export function contentBucket(row: Row, tableName: string): number {
  const table = TABLES.find(table => table.name === tableName)!;
  return parseInt(digest(Buffer.from(keyOf(row, table.key)))[0]!, 16);
}
function objectName(namespace: string, sha256: string, kind: ObjectRef["kind"]): string {
  return `ppc-${namespace}-${sha256}.${kind === "rows" ? "json" : "bin"}`;
}
function validateRef(input: unknown, namespace: string, kind: ObjectRef["kind"]): ObjectRef {
  if (!record(input)) invalid("Invalid content object reference.");
  exactKeys(input, ["filename", "sha256", "size", "kind"], "content object reference");
  if (input.kind !== kind || typeof input.sha256 !== "string" || !HASH.test(input.sha256)
    || input.filename !== objectName(namespace, input.sha256, kind)
    || typeof input.size !== "number" || !Number.isSafeInteger(input.size) || input.size < 0 || input.size > MAX_SNAPSHOT_BYTES) {
    invalid("Unsafe filename, namespace, type, hash or size in content object reference.");
  }
  return input as unknown as ObjectRef;
}

export function parseManifest(input: unknown, expectedNamespace?: string): IncrementalManifest {
  if (Buffer.isBuffer(input) || typeof input === "string") {
    if (Buffer.byteLength(input) > MAX_SNAPSHOT_BYTES) invalid("Manifest exceeds the size limit.", 413);
    try { input = JSON.parse(input.toString()); } catch { invalid("Incremental manifest is not valid JSON."); }
  }
  if (!record(input)) invalid("Invalid incremental manifest.");
  exactKeys(input, ["type", "formatVersion", "namespace", "createdAt", "scope", "source", "schema", "tables", "files"], "manifest");
  if (input.type !== "personal-platform-incremental" || input.formatVersion !== 1) invalid("Unsupported incremental backup format.");
  if (typeof input.namespace !== "string" || !HASH.test(input.namespace) || (expectedNamespace !== undefined && input.namespace !== expectedNamespace)) invalid("Backup namespace does not match this connection and scope.");
  if (input.scope !== "own" && input.scope !== "all") invalid("Invalid incremental backup scope.");
  if (typeof input.createdAt !== "string" || !validTimestamp(input.createdAt)) invalid("Invalid incremental backup creation time.");
  if (!record(input.source)) invalid("Invalid backup source.");
  exactKeys(input.source, ["id", "username"], "manifest source");
  if (typeof input.source.id !== "string" || !UUID.test(input.source.id) || typeof input.source.username !== "string") invalid("Invalid backup source identity.");
  if (!record(input.tables) || !record(input.schema) || !Array.isArray(input.files)) invalid("Invalid manifest table or attachment index.");
  exactKeys(input.schema, Object.keys(input.tables), "manifest schema");
  const allowed = TABLES.filter(table => input.scope === "all" || !table.name.startsWith("core.")).map(table => table.name);
  for (const [name, buckets] of Object.entries(input.tables)) {
    if (!allowed.includes(name) || !Array.isArray(buckets) || buckets.length > 16 || typeof input.schema[name] !== "string" || !HASH.test(input.schema[name])) invalid("Unknown table, schema signature or invalid bucket list.");
    const seen = new Set<number>();
    for (const entry of buckets) {
      if (!record(entry)) invalid("Invalid row bucket.");
      exactKeys(entry, ["bucket", "object"], "row bucket");
      if (typeof entry.bucket !== "number" || !Number.isInteger(entry.bucket) || entry.bucket < 0 || entry.bucket > 15 || seen.has(entry.bucket)) invalid("Invalid or duplicate row bucket.");
      seen.add(entry.bucket);
      validateRef(entry.object, input.namespace, "rows");
    }
  }
  if (input.files.length > MAX_SNAPSHOT_ROWS) invalid("Too many attachment references.", 413);
  const attachments = new Set<string>();
  for (const file of input.files) {
    if (!record(file)) invalid("Invalid attachment reference.");
    exactKeys(file, ["attachmentId", "object"], "manifest attachment");
    if (typeof file.attachmentId !== "string" || !UUID.test(file.attachmentId) || attachments.has(file.attachmentId)) invalid("Invalid or duplicate attachment identity.");
    attachments.add(file.attachmentId);
    validateRef(file.object, input.namespace, "attachment");
  }
  const manifest = input as unknown as IncrementalManifest;
  const refs = getObjectRefs(manifest);
  if (refs.length > MAX_INCREMENTAL_OBJECTS) invalid("Backup exceeds the 1024 content-object limit.", 413);
  if (refs.reduce((total, ref) => total + ref.size, 0) > MAX_SNAPSHOT_BYTES) invalid("Backup content objects exceed the cumulative size limit.", 413);
  // A small deduplicated object store can expand into a huge JSON snapshot
  // when many attachment IDs reuse a blob. Account for every occurrence
  // before any read/base64 allocation, not only distinct object filenames.
  const skeleton: Snapshot = { type: "personal-platform-data", formatVersion: 1, createdAt: manifest.createdAt, scope: manifest.scope, source: manifest.source, schema: manifest.schema, tables: Object.fromEntries(Object.keys(manifest.tables).map(name => [name, []])), files: [] };
  let expanded = Buffer.byteLength(JSON.stringify(skeleton));
  for (const buckets of Object.values(manifest.tables)) {
    // Strip each bucket's array brackets, then add inter-bucket commas.
    expanded += buckets.reduce((total, bucket) => total + Math.max(0, bucket.object.size - 2), 0) + Math.max(0, buckets.length - 1);
  }
  for (const file of manifest.files) {
    expanded += Buffer.byteLength(JSON.stringify({ attachmentId: file.attachmentId, sha256: file.object.sha256, data: "" })) + Math.ceil(file.object.size / 3) * 4;
  }
  expanded += Math.max(0, manifest.files.length - 1);
  if (expanded > MAX_SNAPSHOT_BYTES) invalid("Reconstructed backup exceeds the expanded 32 MiB limit.", 413);
  if (Buffer.byteLength(canonicalJson(manifest)) > MAX_SNAPSHOT_BYTES) invalid("Manifest exceeds the size limit.", 413);
  return manifest;
}

/** Called on parsed manifests. Duplicate attachment contents are fetched only once. */
export function getObjectRefs(manifest: IncrementalManifest): ObjectRef[] {
  const refs = new Map<string, ObjectRef>();
  for (const ref of [...Object.values(manifest.tables).flatMap(buckets => buckets.map(bucket => bucket.object)), ...manifest.files.map(file => file.object)]) {
    const old = refs.get(ref.filename);
    if (old && (old.size !== ref.size || old.sha256 !== ref.sha256 || old.kind !== ref.kind)) invalid("Conflicting content object references.");
    refs.set(ref.filename, ref);
  }
  return [...refs.values()].sort((a, b) => compareText(a.filename, b.filename));
}

export function fingerprintManifest(manifest: IncrementalManifest): string {
  const { createdAt: _ignored, ...content } = manifest;
  return digest(Buffer.from(canonicalJson(content)));
}

/** Cross-row ownership and file correspondence also apply to offline reconstruction. */
function validateRelationships(snapshot: Snapshot): void {
  assertRecordGraph(snapshot, invalid);
}

export function buildIncremental(input: Snapshot, namespace: string): IncrementalPlan {
  if (!HASH.test(namespace)) invalid("Invalid incremental namespace.");
  const snapshot = validateEnvelope(input, { id: input.source.id, role: input.scope === "all" ? "admin" : "user" }, input.scope);
  validateRelationships(snapshot);
  const manifest: IncrementalManifest = {
    type: "personal-platform-incremental", formatVersion: 1, namespace, createdAt: snapshot.createdAt,
    scope: snapshot.scope, source: snapshot.source, schema: snapshot.schema, tables: {}, files: [],
  };
  const objects: IncrementalPlan["objects"] = new Map();
  function add(data: Buffer, kind: ObjectRef["kind"]): ObjectRef {
    const sha256 = digest(data);
    const ref: ObjectRef = { filename: objectName(namespace, sha256, kind), sha256, size: data.length, kind };
    objects.set(ref.filename, { ref, data });
    if (objects.size > MAX_INCREMENTAL_OBJECTS) invalid("Backup exceeds the 1024 content-object limit.", 413);
    return ref;
  }
  for (const name of Object.keys(snapshot.tables).sort()) {
    const table = TABLES.find(table => table.name === name)!;
    const buckets = new Map<number, Row[]>();
    for (const row of snapshot.tables[name]!) {
      const bucket = contentBucket(row, name);
      if (!buckets.has(bucket)) buckets.set(bucket, []);
      buckets.get(bucket)!.push(row);
    }
    manifest.tables[name] = [...buckets.entries()].sort(([a], [b]) => a - b).map(([bucket, rows]) => ({
      bucket,
      object: add(Buffer.from(canonicalJson(rows.sort((a, b) => compareText(keyOf(a, table.key), keyOf(b, table.key))))), "rows"),
    }));
  }
  manifest.files = [...snapshot.files].sort((a, b) => compareText(a.attachmentId, b.attachmentId)).map(file => ({ attachmentId: file.attachmentId, object: add(Buffer.from(file.data, "base64"), "attachment") }));
  parseManifest(manifest, namespace);
  return { manifest, manifestBytes: Buffer.from(canonicalJson(manifest)), objects, fingerprint: fingerprintManifest(manifest), logicalSize: Buffer.byteLength(JSON.stringify(snapshot)) };
}

export async function reconstructManifest(input: IncrementalManifest, readObject: (ref: ObjectRef) => Promise<Buffer>): Promise<Snapshot> {
  const manifest = parseManifest(input);
  const contents = new Map<string, Buffer>();
  let bytes = 0;
  for (const ref of getObjectRefs(manifest)) {
    const data = await readObject(ref);
    if (!Buffer.isBuffer(data) || data.length !== ref.size || digest(data) !== ref.sha256) invalid("Content object size or SHA-256 differs from the manifest.");
    bytes += data.length;
    if (bytes > MAX_SNAPSHOT_BYTES) invalid("Backup content exceeds the cumulative size limit.", 413);
    contents.set(ref.filename, data);
  }
  const snapshot: Snapshot = { type: "personal-platform-data", formatVersion: 1, createdAt: manifest.createdAt, scope: manifest.scope, source: manifest.source, schema: manifest.schema, tables: {}, files: [] };
  let rowCount = 0;
  for (const [name, buckets] of Object.entries(manifest.tables)) {
    const rows: Row[] = [];
    for (const bucket of buckets) {
      let decoded: unknown;
      try { decoded = JSON.parse(contents.get(bucket.object.filename)!.toString("utf8")); } catch { invalid("Row content object is not valid JSON."); }
      if (!Array.isArray(decoded) || !decoded.length || decoded.some(row => !record(row))) invalid("Invalid row content object.");
      rowCount += decoded.length;
      if (rowCount > MAX_SNAPSHOT_ROWS) invalid("Backup exceeds the row limit.", 413);
      for (const row of decoded as Row[]) {
        if (contentBucket(row, name) !== bucket.bucket) invalid("Record is in the wrong content bucket.");
        rows.push(row);
      }
    }
    const keys = TABLES.find(table => table.name === name)!.key;
    snapshot.tables[name] = rows.sort((a, b) => compareText(keyOf(a, keys), keyOf(b, keys)));
  }
  snapshot.files = manifest.files.map(file => ({ attachmentId: file.attachmentId, sha256: file.object.sha256, data: contents.get(file.object.filename)!.toString("base64") }));
  validateEnvelope(snapshot, { id: snapshot.source.id, role: snapshot.scope === "all" ? "admin" : "user" }, snapshot.scope);
  validateRelationships(snapshot);
  return snapshot;
}
