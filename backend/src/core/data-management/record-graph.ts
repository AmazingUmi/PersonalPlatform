import {
  TABLES, UUID, digest, keyOf, type Row, type Snapshot,
} from "./snapshot-schema.js";

/** Relationship, owner, and attachment checks shared by backup reconstruction and sync. */
export function assertRecordGraph(snapshot: Snapshot, fail: (message: string) => never): void {
  const byId = new Map<string, Map<unknown, Row>>();
  for (const [name, rows] of Object.entries(snapshot.tables)) byId.set(name, new Map(rows.map(row => [row.id, row])));
  const owners = new Set((snapshot.tables["core.users"] ?? []).map(row => row.id));
  for (const table of TABLES) {
    const names = new Set<string>();
    for (const row of snapshot.tables[table.name] ?? []) {
    for (const key of table.key) {
      if (typeof row[key] !== "string") fail("Invalid primary-key value in backup.");
      if ((key.endsWith("_id") || (key === "id" && !["clock.settings", "focus.settings", "mini_game.saves"].includes(table.name))) && !UUID.test(row[key] as string)) fail("Invalid record UUID in backup.");
    }
    if ("user_id" in row && (typeof row.user_id !== "string" || !UUID.test(row.user_id))) fail("Invalid record owner.");
    if (snapshot.scope === "all" && "user_id" in row && !owners.has(row.user_id)) fail("Missing account for an owned record.");
    const ownerIds: unknown[] = "user_id" in row ? [row.user_id] : [];
    for (const [column, parent] of Object.entries(table.parents ?? {})) {
      const record = byId.get(parent)?.get(row[column]);
      if (!record) fail("Missing parent in reconstructed backup.");
      ownerIds.push(record.user_id);
    }
    if (ownerIds.some(owner => owner !== ownerIds[0])) fail("Cross-user relationship in reconstructed backup.");
    if (table.natural) {
      const nk = keyOf(row, ["user_id", table.natural]);
      if (names.has(nk)) fail("Duplicate name in " + table.name);
      names.add(nk);
    }
    }
  }
  const rows = snapshot.tables["assets.attachments"] ?? [];
  if (rows.length !== snapshot.files.length) fail("Attachment metadata and content references do not match.");
  const files = new Map(snapshot.files.map(file => [file.attachmentId, file]));
  for (const row of rows) {
    const file = files.get(String(row.id));
    const bytes = file ? decodedAttachment(file.data) : null;
    if (!file || !bytes || !/^(0|[1-9]\d*)$/.test(String(row.size)) || BigInt(String(row.size)) !== BigInt(bytes.length) || digest(bytes) !== file.sha256) fail("Attachment size or identity differs from its content.");
    if (typeof row.storage_key === "string" && unsafeStorageKey(row.storage_key)) fail("Attachment storage path is not server-owned.");
  }
}

function decodedAttachment(data: string): Buffer | null {
  if (typeof data !== "string" || data.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(data)) return null;
  const bytes = Buffer.from(data, "base64");
  return bytes.toString("base64") === data ? bytes : null;
}

/** Reject traversal segments. A generated key may contain the letters "..". */
function unsafeStorageKey(key: string): boolean {
  if (key.startsWith("/") || key.includes("\\")) return true;
  return key.split("/").some(part => part === "" || part === "." || part === "..");
}
