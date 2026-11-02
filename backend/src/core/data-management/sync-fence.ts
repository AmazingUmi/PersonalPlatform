import { AppError } from "../api/errors.js";
import type { DatabaseContext } from "../database/index.js";
import { dataLockNames } from "./data-lock.js";
import { canonicalJson } from "./incremental.js";
import { digest, TABLES, type Row } from "./snapshot-schema.js";
import { semanticHash, syncKeyOf } from "./sync-protocol.js";

/** Phases where a remote apply can still land, including paused or disabled sync. */
const FENCED_PHASES = new Set(["bootstrap", "linked", "publication_unknown"]);

const TABLE_NAME = /^[a-z][a-z0-9_]*\.[a-z][a-z0-9_]*$/;
const HASH_TEXT = /^[0-9a-f]{64}$/;

export interface HashPart {
  table: string;
  row: Row;
  contentSha256?: string;
}

/**
 * One row uses `semanticHash`, so it matches the sync row hash.
 * Several rows hash the sorted sync-key set. Link and child edits change
 * that set even when the parent columns do not.
 */
export function editorBaseHash(parts: readonly HashPart[]): string {
  if (parts.length === 0) throw new Error("editorBaseHash requires a snapshot");
  const keyed = parts.map((part) => ({
    key: syncKeyOf(part.table, part.row),
    hash: semanticHash(part.row, part.contentSha256),
  }));
  keyed.sort((left, right) => (left.key < right.key ? -1 : left.key > right.key ? 1 : 0));
  if (keyed.length === 1) return keyed[0]!.hash;
  return digest(Buffer.from(canonicalJson(keyed)));
}

/** Stable proof for a singleton that has no row yet. `row` is the default snapshot, not an API view. */
export function singletonBaseHash(table: string, row: Row): string {
  return editorBaseHash([{ table, row }]);
}

export function parseSnapshotRow(value: string): Row {
  const parsed: unknown = JSON.parse(value);
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("row snapshot is not an object");
  }
  return parsed as Row;
}

export function parseSnapshotRows(value: unknown): Row[] {
  if (value == null) return [];
  const parsed: unknown = typeof value === "string" ? JSON.parse(value) : value;
  if (!Array.isArray(parsed)) throw new Error("row snapshot list is not an array");
  return parsed.map((row) => {
    if (row === null || typeof row !== "object" || Array.isArray(row)) throw new Error("row snapshot is not an object");
    return row as Row;
  });
}

/** `probing` and `unlinked` stay optional. A missing binding is optional. `enabled` does not open the fence. */
export async function syncWriteFenced(tx: DatabaseContext, userId: string): Promise<boolean> {
  const { rows } = await tx.query<{ phase: string }>(
    "SELECT phase FROM core.sync_bindings WHERE user_id = $1",
    [userId],
  );
  return rows[0] !== undefined && FENCED_PHASES.has(rows[0].phase);
}

function quoteIdent(name: string): string {
  return name.split(".").map((part) => `"${part}"`).join(".");
}

/**
 * Sorted `ROW EXCLUSIVE` locks on this app's tables, on the caller's transaction.
 * Taken before row locks and advisory locks. Does not open a connection and
 * does not lock `core` or another app.
 */
export async function lockOwnedTables(tx: DatabaseContext, tables: readonly string[]): Promise<void> {
  if (tables.length === 0) throw new Error("lockOwnedTables requires tables");
  const names = dataLockNames(tables);
  const schema = names[0]!.split(".")[0]!;
  for (const name of names) {
    if (!TABLE_NAME.test(name) || name.split(".")[0] !== schema || schema === "core" || !TABLES.some((table) => table.name === name)) {
      throw new Error("fence table is not an owned app table: " + name);
    }
  }
  await tx.query("SET LOCAL lock_timeout = '5s'");
  try {
    await tx.query(`LOCK TABLE ${names.map(quoteIdent).join(", ")} IN ROW EXCLUSIVE MODE`);
  } catch (error) {
    if ((error as { code?: string }).code === "55P03") {
      throw new AppError(409, "sync_busy", "Data is being updated. Retry this save.");
    }
    throw error;
  }
}

const OWNER_KEY = /^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)?$/;

/** Serializes inserts that have no existing row to lock. Call only after `lockOwnedTables`. */
export async function lockOwnerSet(tx: DatabaseContext, userId: string, table: string): Promise<void> {
  if (!OWNER_KEY.test(table) || table === "core" || table.startsWith("core.")) {
    throw new Error("fence owner set table is invalid");
  }
  await tx.query("SELECT pg_advisory_xact_lock(hashtext($1), hashtext($2))", [table, userId]);
}

export function readPresentedHash(value: unknown): string | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  if (typeof value !== "string" || !HASH_TEXT.test(value)) {
    throw new AppError(400, "validation_error", "baseHash must be a 64 character hex string");
  }
  return value;
}

export function headerPresentedHash(header: unknown): string | undefined {
  const value = Array.isArray(header) ? header[0] : header;
  return readPresentedHash(value);
}

/**
 * A presented hash is always checked. A missing hash is rejected only while fenced.
 * The message does not include the hash or the binding.
 */
export function assertPresentedHash(fenced: boolean, presented: string | undefined, actual: string): void {
  if (presented === undefined) {
    if (fenced) throw new AppError(409, "sync_base_required", "Reload this record before saving.");
    return;
  }
  if (presented !== actual) throw new AppError(409, "sync_stale", "This record changed. Reload it before saving.");
}
