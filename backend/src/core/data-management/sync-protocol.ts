import { createHash, randomBytes, randomUUID } from "node:crypto";
import { canonicalJson } from "./incremental.js";
import { TABLES, UUID, digest, type Row } from "./snapshot-schema.js";

const EXCLUDED = new Set(["updated_at", "revision", "user_id", "storage_key"]);
const CODE_PREFIX = "ppss1.";

export interface PendingPublication {
  opToken: string;
  contentHash: string;
  captureHash: string;
  applied: boolean;
  parentOpToken: string | null;
  parentContentHash: string | null;
  parentEtag: string | null;
}

export interface BaselineEntry {
  hash: string;
  highScore?: number;
}

export type PublicationRecovery = "commit-remote" | "retry-same" | "lost-race" | "retain-pending" | "none";

export type SyncAction =
  | { type: "unchanged"; key: string }
  | { type: "apply-remote"; key: string; row: Row }
  | { type: "pending-local"; key: string; row: Row }
  | { type: "publish-tombstone"; key: string }
  | { type: "adopt-tombstone"; key: string }
  | { type: "delete-local"; key: string }
  | { type: "raise-high-score"; key: string; highScore: number }
  | { type: "conflict"; key: string; reason: string; local?: Row; remote?: Row; highScore?: number };

export interface ReconcileResult {
  actions: SyncAction[];
  invalid: string | null;
}

export function projectRow(row: Row): Row {
  const projected: Row = {};
  for (const key of Object.keys(row).sort()) {
    if (!EXCLUDED.has(key)) projected[key] = row[key];
  }
  return projected;
}

/** `contentSha256` is the attachment bytes hash. It is not a database column. */
export function semanticHash(row: Row, contentSha256?: string): string {
  const projected = projectRow(row);
  if (contentSha256 !== undefined) projected.content_sha256 = contentSha256;
  return digest(Buffer.from(canonicalJson(projected)));
}

export function syncKeyOf(table: string, row: Row): string {
  const spec = TABLES.find(item => item.name === table);
  if (!spec) throw new Error("Unsupported sync table " + table);
  const parts = spec.key.filter(key => key !== "user_id").map(key => row[key]);
  return table + ":" + canonicalJson(parts);
}

export function createPairingMaterial(): { identityId: string; secret: Buffer; verifier: string; code: string } {
  const identityId = randomUUID();
  const secret = randomBytes(32);
  return { identityId, secret, verifier: pairingVerifier(secret), code: formatPairingCode(identityId, secret) };
}

export function pairingVerifier(secret: Buffer): string {
  return createHash("sha256").update(secret).digest("hex");
}

export function formatPairingCode(identityId: string, secret: Buffer): string {
  if (!UUID.test(identityId) || secret.length !== 32) throw new Error("Invalid pairing material.");
  const body = Buffer.concat([uuidBytes(identityId), secret]);
  return CODE_PREFIX + body.toString("base64url");
}

export function parsePairingCode(code: string): { identityId: string; secret: Buffer; verifier: string } {
  if (!code.startsWith(CODE_PREFIX)) throw new Error("Pairing code is not a sync identity.");
  const body = Buffer.from(code.slice(CODE_PREFIX.length), "base64url");
  if (body.length !== 48) throw new Error("Pairing code is incomplete.");
  const identityId = bytesToUuid(body.subarray(0, 16));
  const secret = Buffer.from(body.subarray(16));
  return { identityId, secret, verifier: pairingVerifier(secret) };
}

/** Redact pairing codes before any log line is assembled. */
export function redactSyncText(value: string): string {
  return value.replace(/ppss1\.[A-Za-z0-9_-]+/g, "ppss1.[redacted]");
}

export function reconcile(input: {
  baselineEstablished: boolean;
  base: ReadonlyMap<string, string | BaselineEntry>;
  local: ReadonlyMap<string, Row>;
  remote: ReadonlyMap<string, Row>;
  remoteTombstones: ReadonlySet<string>;
  localTombstones: ReadonlySet<string>;
  /** Validated attachment byte hashes keyed by sync key. Row metadata alone is not the content. */
  content?: { local?: ReadonlyMap<string, string>; remote?: ReadonlyMap<string, string> };
}): ReconcileResult {
  const actions: SyncAction[] = [];
  const hashed = {
    local: (key: string, row: Row) => semanticHash(row, input.content?.local?.get(key)),
    remote: (key: string, row: Row) => semanticHash(row, input.content?.remote?.get(key)),
  };
  for (const key of input.remoteTombstones) {
    if (input.remote.has(key)) return { actions: [], invalid: "Remote head lists " + key + " as both live and deleted." };
  }
  if (input.baselineEstablished) {
    for (const key of input.base.keys()) {
      if (!input.remote.has(key) && !input.remoteTombstones.has(key)) {
        return { actions: [], invalid: "Remote head dropped " + key + " without a tombstone." };
      }
    }
  }
  const keys = new Set<string>([
    ...input.base.keys(), ...input.local.keys(), ...input.remote.keys(),
    ...input.remoteTombstones, ...input.localTombstones,
  ]);
  for (const key of [...keys].sort()) {
    const local = input.local.get(key);
    const remote = input.remote.get(key);
    const base = baselineOf(input.base.get(key));
    const baseHash = base?.hash;
    const remoteGone = input.remoteTombstones.has(key);
    if (input.localTombstones.has(key) && local) {
      actions.push({ type: "conflict", key, reason: "resurrection", local, ...(remote ? { remote } : {}), highScore: maxHighScore(local, remote, base?.highScore) });
      continue;
    }
    const localGone = input.localTombstones.has(key) || (input.baselineEstablished && baseHash !== undefined && !local);
    if (!input.baselineEstablished) {
      if (remoteGone && local) {
        actions.push({ type: "conflict", key, reason: "tombstone", local, remote, highScore: maxHighScore(local, remote) });
        continue;
      }
      if (remoteGone && !local) { actions.push({ type: "adopt-tombstone", key }); continue; }
      if (local && remote) {
        classifyBoth(actions, key, local, remote, hashed);
        continue;
      }
      if (local) actions.push({ type: "pending-local", key, row: local });
      else if (remote) actions.push({ type: "apply-remote", key, row: remote });
      continue;
    }
    if (remoteGone && local && !localGone) {
      if (hashed.local(key, local) === baseHash) actions.push({ type: "delete-local", key });
      else actions.push({ type: "conflict", key, reason: "tombstone", local, highScore: maxHighScore(local, undefined, base?.highScore) });
      continue;
    }
    if (remoteGone && !local) {
      // Already acknowledged absence (tombstoned, no deletion hash) is not applied again.
      if (input.localTombstones.has(key) && baseHash === undefined) actions.push({ type: "unchanged", key });
      else if (input.localTombstones.has(key)) actions.push({ type: "publish-tombstone", key });
      else actions.push({ type: "adopt-tombstone", key });
      continue;
    }
    // Acknowledged absence stores no hash. A later live remote row is applied.
    // Pending explicit deletion stores the reviewed hash and must not be undone:
    // the same remote version is published as a tombstone, and a newer one conflicts.
    if (localGone && remote && !remoteGone && input.localTombstones.has(key)) {
      if (baseHash === undefined) actions.push({ type: "apply-remote", key, row: remote });
      else if (hashed.remote(key, remote) === baseHash) actions.push({ type: "publish-tombstone", key });
      else actions.push({ type: "conflict", key, reason: "deleted-locally", remote, highScore: maxHighScore(undefined, remote, base?.highScore) });
      continue;
    }
    if (localGone && remote) {
      if (baseHash !== undefined && hashed.remote(key, remote) === baseHash) actions.push({ type: "publish-tombstone", key });
      else actions.push({ type: "conflict", key, reason: "deleted-locally", remote, highScore: maxHighScore(undefined, remote, base?.highScore) });
      continue;
    }
    if (localGone && !remote) { actions.push({ type: "publish-tombstone", key }); continue; }
    if (local && remote) classifyEstablished(actions, key, local, remote, base, hashed);
    else if (local && !remote) actions.push({ type: "pending-local", key, row: local });
    else if (remote && !local) actions.push({ type: "apply-remote", key, row: remote });
  }
  suppressUnsafeFocus(actions, input.local);
  return { actions, invalid: null };
}

/** A cloud 304 is not idle when this replica has unpublished local edits. */
export function cycleDecision(remoteUnchanged: boolean, actions: readonly SyncAction[]): "idle" | "publish" | "apply" | "conflicted" {
  const meaningful = actions.filter(action => action.type !== "unchanged" && action.type !== "adopt-tombstone");
  if (meaningful.some(action => action.type === "conflict")) return "conflicted";
  const localOutbound = meaningful.some(action => action.type === "pending-local" || action.type === "publish-tombstone" || action.type === "raise-high-score");
  if (remoteUnchanged && !localOutbound && !meaningful.some(action => action.type === "apply-remote" || action.type === "delete-local")) return "idle";
  if (localOutbound || !remoteUnchanged) return meaningful.some(action => action.type === "apply-remote" || action.type === "delete-local") && !localOutbound && remoteUnchanged ? "apply" : localOutbound && remoteUnchanged ? "publish" : "apply";
  return "apply";
}

/**
 * Decide the next step from a journaled parent and pending op.
 * This does not itself persist the journal; the service must do that before CAS.
 */
export function recoverPublication(input: {
  pending: PendingPublication | null;
  remoteOpToken: string | null;
  remoteContentHash: string | null;
  remoteEtag: string | null;
  localCaptureHash: string;
}): PublicationRecovery {
  const pending = input.pending;
  if (!pending) return "none";
  const localMoved = input.localCaptureHash !== pending.captureHash;
  const remoteIsPending = input.remoteOpToken === pending.opToken && input.remoteContentHash === pending.contentHash;
  const remoteIsParent = pending.parentOpToken !== null && input.remoteOpToken === pending.parentOpToken
    && input.remoteContentHash === pending.parentContentHash && input.remoteEtag === pending.parentEtag;
  if (remoteIsPending) return pending.applied && !localMoved ? "commit-remote" : "retain-pending";
  if (localMoved) return "retain-pending";
  if (remoteIsParent) return "retry-same";
  if (input.remoteOpToken && input.remoteOpToken !== pending.opToken) return "lost-race";
  return "retry-same";
}

/** Continue a bootstrap or upload at the first hash that is not already cached. */
export function selectTransfers(needed: readonly string[], cached: ReadonlySet<string>, budget: number): { transfer: string[]; done: boolean } {
  if (!Number.isSafeInteger(budget) || budget < 1) throw new Error("Transfer budget must be a positive integer.");
  const transfer: string[] = [];
  for (const hash of needed) {
    if (cached.has(hash)) continue;
    if (transfer.length >= budget) return { transfer, done: false };
    transfer.push(hash);
  }
  return { transfer, done: true };
}

function classifyBoth(actions: SyncAction[], key: string, local: Row, remote: Row, hashed: HashPair): void {
  const highScore = maxHighScore(local, remote);
  const localHash = hashed.local(key, local);
  const remoteHash = hashed.remote(key, remote);
  if (localHash === remoteHash) {
    actions.push({ type: "unchanged", key });
    if (highScore !== undefined && highScoreOf(local) !== highScore) actions.push({ type: "raise-high-score", key, highScore });
    return;
  }
  const normalized = { ...remote };
  if (typeof local.high_score === "number") normalized.high_score = local.high_score;
  else delete normalized.high_score;
  if (sameExceptHighScore(local, remote) && hashed.local(key, local) === hashed.remote(key, normalized)) {
    actions.push({ type: "raise-high-score", key, highScore: highScore! });
    return;
  }
  actions.push({ type: "conflict", key, reason: "diverged", local, remote, ...(highScore !== undefined ? { highScore } : {}) });
}

type HashPair = { local: (key: string, row: Row) => string; remote: (key: string, row: Row) => string };

function classifyEstablished(actions: SyncAction[], key: string, local: Row, remote: Row, base: BaselineEntry | undefined, hashed: HashPair): void {
  const high = maxHighScore(local, remote, base?.highScore);
  const localRow = preserveHighScore(local, high);
  const remoteRow = preserveHighScore(remote, high);
  const localHash = hashed.local(key, localRow);
  const remoteHash = hashed.remote(key, remoteRow);
  if (localHash === remoteHash) {
    const localHigh = highScoreOf(local);
    const remoteHigh = highScoreOf(remote);
    if (high !== undefined && localHigh !== undefined && localHigh < high) actions.push({ type: "raise-high-score", key, highScore: high });
    else if (high !== undefined && remoteHigh !== undefined && remoteHigh < high) actions.push({ type: "pending-local", key, row: localRow });
    else actions.push({ type: "unchanged", key });
    return;
  }
  if (base?.hash !== undefined && hashed.local(key, local) === base.hash) { actions.push({ type: "apply-remote", key, row: remoteRow }); return; }
  if (base?.hash !== undefined && hashed.remote(key, remote) === base.hash) { actions.push({ type: "pending-local", key, row: localRow }); return; }
  classifyBoth(actions, key, localRow, remoteRow, hashed);
}

function baselineOf(value: string | BaselineEntry | undefined): BaselineEntry | undefined {
  if (value === undefined) return undefined;
  return typeof value === "string" ? { hash: value } : value;
}

function preserveHighScore(row: Row, highScore: number | undefined): Row {
  if (highScore === undefined || typeof row.high_score !== "number" || row.high_score === highScore) return row;
  return { ...row, high_score: highScore };
}

function suppressUnsafeFocus(actions: SyncAction[], local: ReadonlyMap<string, Row>): void {
  const activeLocal = [...local.entries()].filter(([key, row]) => key.startsWith("focus.sessions:") && isActive(row));
  for (const action of [...actions]) {
    const remoteRow = action.type === "apply-remote" ? action.row : action.type === "conflict" ? action.remote : undefined;
    const deletesActive = action.type === "delete-local" && activeLocal.some(([key]) => key === action.key);
    const importsOtherActive = action.type === "apply-remote" && isActive(action.row) && activeLocal.some(([key]) => key !== action.key);
    if (!deletesActive && !importsOtherActive) continue;
    const index = actions.indexOf(action);
    const localRow = local.get(action.key);
    actions.splice(index, 1, {
      type: "conflict", key: action.key, reason: "focus-active",
      ...(localRow ? { local: localRow } : {}),
      ...(remoteRow ? { remote: remoteRow } : {}),
    });
  }
}

function isActive(row: Row | undefined): boolean {
  return row?.status === "running" || row?.status === "paused";
}

function highScoreOf(row: Row | undefined): number | undefined {
  const value = row?.high_score;
  return typeof value === "number" ? value : undefined;
}

function maxHighScore(local: Row | undefined, remote: Row | undefined, base?: number): number | undefined {
  const values = [highScoreOf(local), highScoreOf(remote), base].filter((value): value is number => value !== undefined);
  return values.length ? Math.max(...values) : undefined;
}

function sameExceptHighScore(local: Row, remote: Row): boolean {
  const left = projectRow(local), right = projectRow(remote);
  delete left.high_score; delete right.high_score;
  return canonicalJson(left) === canonicalJson(right);
}

function uuidBytes(identityId: string): Buffer {
  return Buffer.from(identityId.replace(/-/g, ""), "hex");
}

function bytesToUuid(bytes: Buffer): string {
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
