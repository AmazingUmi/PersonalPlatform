import { AppError } from "../api/errors.js";
import { assertRecordGraph } from "./record-graph.js";
import { semanticHash, syncKeyOf } from "./sync-protocol.js";
import {
  TABLES, UUID, digest, validateEnvelope, validateRow,
  type Column, type Row, type Snapshot,
} from "./snapshot-schema.js";

export interface SyncFile {
  attachmentId: string;
  sha256: string;
  size: number;
  data: string;
}

/** Same bytes as the live catalog fingerprint: column name, type, nullability, ordered by name. */
export function columnSignature(columns: readonly Column[]): string {
  const ordered = [...columns].map(column => ({ name: column.name, type: column.type, nullable: column.nullable === true }))
    .sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
  return digest(Buffer.from(JSON.stringify(ordered)));
}

/**
 * Validate the remote wire shape before rewriting ownership.
 * `columns` is the live catalog (name, type, nullability), not a guessed type map.
 * A thrown error discards the whole plan.
 */
export function validateSyncPlan(input: {
  actorId: string;
  remoteOwnerId: string;
  columns: ReadonlyMap<string, Column[]>;
  schema: Record<string, string>;
  expectedSchema: Record<string, string>;
  tables: Record<string, Row[]>;
  files: SyncFile[];
}): { tables: Record<string, Row[]>; hashes: Map<string, string>; files: { attachmentId: string; sha256: string; data: string }[] } {
  if (!UUID.test(input.actorId) || !UUID.test(input.remoteOwnerId)) fail("Invalid authenticated identity.");
  if (Object.keys(input.schema).some(name => name.startsWith("core.")) || Object.keys(input.tables).some(name => name.startsWith("core."))) {
    fail("Sync does not carry core data.");
  }
  const names = Object.keys(input.tables).sort().join("|");
  if (Object.keys(input.schema).sort().join("|") !== names || Object.keys(input.expectedSchema).sort().join("|") !== names) {
    fail("Sync table set and schema fingerprints must match exactly.");
  }
  for (const name of Object.keys(input.tables)) {
    if (!TABLES.some(table => table.name === name)) fail("Unsupported sync table " + name);
    if (input.schema[name] !== input.expectedSchema[name]) fail("Backup schema is incompatible with " + name + ".");
    if (!input.columns.has(name)) fail("Missing column catalog for " + name + ".");
  }
  const wireFiles = input.files.map(file => {
    if (typeof file.size !== "number" || !Number.isSafeInteger(file.size) || file.size < 0) fail("Attachment size is not a byte count.");
    const wire = { attachmentId: file.attachmentId, sha256: file.sha256, data: file.data };
    const bytes = Buffer.from(file.data, "base64");
    if (bytes.length !== file.size) fail("Attachment size does not match its bytes.");
    return wire;
  });
  const snapshot: Snapshot = {
    type: "personal-platform-data", formatVersion: 1, createdAt: "2026-01-01T00:00:00.000Z",
    scope: "own", source: { id: input.remoteOwnerId, username: "sync-owner" },
    schema: input.schema, tables: input.tables, files: wireFiles,
  };
  try {
    validateEnvelope(snapshot, { id: input.remoteOwnerId, role: "user" }, "own");
    for (const [name, rows] of Object.entries(input.tables)) {
      const columns = input.columns.get(name)!;
      for (const row of rows) validateRow(row, columns, name);
    }
  } catch (error) {
    if (error instanceof AppError && error.code === "invalid_snapshot") fail(error.message);
    throw error;
  }
  assertRecordGraph(snapshot, fail);
  const tables: Record<string, Row[]> = {};
  const hashes = new Map<string, string>();
  const files = new Map(input.files.map(file => [file.attachmentId, file.sha256]));
  for (const [name, rows] of Object.entries(input.tables)) {
    tables[name] = rows.map(row => rewriteRow(row, input.actorId));
    for (const row of tables[name]) {
      const content = name === "assets.attachments" ? files.get(String(row.id)) : undefined;
      if (name === "assets.attachments" && content === undefined) fail("Attachment metadata and content references do not match.");
      hashes.set(syncKeyOf(name, row), semanticHash(row, content));
    }
  }
  return { tables, hashes, files: wireFiles };
}

function rewriteRow(row: Row, actorId: string): Row {
  const copy: Row = { ...row };
  if ("user_id" in copy) copy.user_id = actorId;
  if ("storage_key" in copy) delete copy.storage_key;
  delete copy.content_sha256;
  return copy;
}

function fail(message: string): never {
  throw new AppError(422, "invalid_sync", message);
}
