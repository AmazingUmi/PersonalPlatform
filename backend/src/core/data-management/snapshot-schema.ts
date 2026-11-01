import { createHash } from 'node:crypto';
import { AppError } from '../api/errors.js';
import { USERNAME_PATTERN } from '../auth/service.js';
import { isValidTimezone } from '../time/index.js';

export const MAX_SNAPSHOT_BYTES = 32 * 1024 * 1024;
export const MAX_SNAPSHOT_ROWS = 100_000;
export type Scope = 'own' | 'all';
export type Row = Record<string, unknown>;
export interface Actor { id: string; role: string }
export interface Snapshot {
  type: 'personal-platform-data'; formatVersion: 1; createdAt: string; scope: Scope;
  source: { id: string; username: string };
  schema: Record<string, string>;
  tables: Record<string, Row[]>;
  files: { attachmentId: string; sha256: string; data: string }[];
}
export interface TableSpec { name: string; columns: string[]; key: string[]; natural?: string; parents?: Record<string, string> }
function spec(name: string, columns: string, key = 'id', extra: Partial<TableSpec> = {}): TableSpec {
  return { name, columns: columns.split(' '), key: key.split(' '), ...extra };
}
export const TABLES: TableSpec[] = [
  spec('core.users', 'id username password_hash display_name role status created_at updated_at last_login_at'),
  spec('core.settings', 'key value updated_at', 'key'),
  spec('tasks.tasks', 'id title description status due_at completed_at created_at updated_at start_at priority user_id'),
  spec('notes.notes', 'id title content mood occurred_at pinned created_at updated_at user_id'),
  spec('notes.tags', 'id name created_at user_id', 'id', { natural: 'name' }),
  spec('notes.note_tags', 'note_id tag_id', 'note_id tag_id', { parents: { note_id: 'notes.notes', tag_id: 'notes.tags' } }),
  spec('assets.categories', 'id name created_at color user_id', 'id', { natural: 'name' }),
  spec('assets.items', 'id name description quantity acquired_at created_at updated_at target_location user_id'),
  spec('assets.item_categories', 'item_id category_id', 'item_id category_id', { parents: { item_id: 'assets.items', category_id: 'assets.categories' } }),
  spec('assets.attachments', 'id item_id filename content_type size storage_key created_at user_id', 'id', { parents: { item_id: 'assets.items' } }),
  spec('clock.settings', 'id value updated_at user_id', 'user_id id'),
  spec('clock.alarms', 'id time label enabled repeat_days created_at updated_at user_id'),
  spec('clock.world_clocks', 'id city timezone sort_order created_at updated_at user_id'),
  spec('focus.settings', 'id value updated_at user_id', 'user_id id'),
  spec('focus.sessions', 'id kind status planned_duration_seconds elapsed_before_pause_seconds started_at last_resumed_at paused_at ended_at end_reason actual_duration_seconds revision created_at updated_at user_id'),
  spec('mini_game.saves', 'id score board updated_at high_score revision user_id', 'user_id id'),
];
export const SETTINGS_KEYS = ['dashboard.widgets', 'apps.presentation'];
export const APP_IDS = [...new Set(TABLES.map(t => t.name.split('.')[0]!).filter(n => n !== 'core'))];
export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
export function fail(message: string, status = 422): never { throw new AppError(status, 'invalid_snapshot', message); }
export function authorize(actor: Actor, scope: Scope): void {
  if (!UUID.test(actor.id)) fail('Invalid authenticated identity.', 403);
  if (scope !== 'own' && scope !== 'all') fail('Choose own or all data.');
  if (scope === 'all' && actor.role !== 'admin') fail('Administrator role required for all data.', 403);
}
export function record(value: unknown): value is Row { return value !== null && typeof value === 'object' && !Array.isArray(value); }
export function exactKeys(value: Row, names: string[], label: string): void {
  if (Object.keys(value).sort().join('|') !== [...names].sort().join('|')) fail('Unexpected or missing fields in ' + label + '.');
}
export function digest(data: Buffer): string { return createHash('sha256').update(data).digest('hex'); }
export function keyOf(row: Row, columns: string[]): string { return JSON.stringify(columns.map(c => row[c])); }
export function validateEnvelope(input: unknown, actor: Actor, scope: Scope): Snapshot {
  authorize(actor, scope);
  let size: number;
  try { size = Buffer.byteLength(JSON.stringify(input)); } catch { fail('Backup is not JSON data.'); }
  if (size > MAX_SNAPSHOT_BYTES) fail('Backup exceeds the 32 MiB limit.', 413);
  if (!record(input)) fail('Choose a Settings JSON backup; SQL and archive files require offline conversion.');
  exactKeys(input, ['type','formatVersion','createdAt','scope','source','schema','tables','files'], 'backup');
  if (input.type !== 'personal-platform-data' || input.formatVersion !== 1) fail('Unsupported backup format. Use a Settings JSON backup or convert a trusted legacy backup offline.');
  if (input.scope !== scope) fail('Backup scope must match the selected import scope.', scope === 'own' && input.scope === 'all' ? 403 : 422);
  if (typeof input.createdAt !== 'string' || !validTimestamp(input.createdAt)) fail('Invalid backup creation time.');
  if (!record(input.source)) fail('Invalid backup source.');
  exactKeys(input.source, ['id','username'], 'source');
  if (typeof input.source.id !== 'string' || !UUID.test(input.source.id) || typeof input.source.username !== 'string') fail('Invalid backup source.');
  if (!record(input.schema) || !record(input.tables) || !Array.isArray(input.files)) fail('Invalid backup tables or files.');
  const allowed = TABLES.filter(t => scope === 'all' || !t.name.startsWith('core.')).map(t => t.name);
  for (const name of Object.keys(input.tables)) if (!allowed.includes(name)) fail('Unsupported backup table: ' + name);
  exactKeys(input.schema, Object.keys(input.tables), 'schema');
  let count = 0;
  for (const [name, rows] of Object.entries(input.tables)) {
    if (!Array.isArray(rows) || rows.some(r => !record(r))) fail('Invalid rows in ' + name);
    count += rows.length;
    if (count > MAX_SNAPSHOT_ROWS) fail('Backup exceeds the row limit.', 413);
    const table = TABLES.find(t => t.name === name)!;
    const keys = new Set<string>(); const natural = new Set<string>();
    for (const row of rows as Row[]) {
      exactKeys(row, table.columns, name);
      const key = keyOf(row, table.key);
      if (keys.has(key)) fail('Duplicate primary key in ' + name);
      keys.add(key);
      if (table.natural) {
        const nk = keyOf(row, ['user_id', table.natural]);
        if (natural.has(nk)) fail('Duplicate name in ' + name);
        natural.add(nk);
      }
      if (scope === 'own' && 'user_id' in row && row.user_id !== input.source.id) fail('Backup contains more than one owner.');
    }
  }
  if (input.files.length > MAX_SNAPSHOT_ROWS) fail('Too many attachment files.');
  const ids = new Set<string>();
  for (const file of input.files) {
    if (!record(file)) fail('Invalid attachment file.');
    exactKeys(file, ['attachmentId','sha256','data'], 'attachment file');
    if (typeof file.attachmentId !== 'string' || !UUID.test(file.attachmentId) || ids.has(file.attachmentId)) fail('Invalid or duplicate attachment file ID.');
    ids.add(file.attachmentId);
    if (typeof file.data !== 'string' || typeof file.sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(file.sha256)) fail('Invalid attachment encoding.');
    const bytes = Buffer.from(file.data, 'base64');
    if (bytes.toString('base64') !== file.data || digest(bytes) !== file.sha256) fail('Attachment checksum mismatch.');
  }
  return input as unknown as Snapshot;
}
export function validTimestamp(value: string): boolean {
  return /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?(?:Z|[+-]\d{2}:\d{2})$/.test(value) && Number.isFinite(Date.parse(value));
}
export interface Column { name: string; type: string; nullable: boolean }
export function validateRow(row: Row, columns: Column[], table: string): void {
  for (const col of columns) {
    const v = row[col.name];
    // JSON null is a JSON value, including for NOT NULL jsonb columns.
    // Import stringifies jsonb parameters, so it is not SQL NULL.
    if (v === null) { if (!col.nullable && col.type !== 'jsonb') fail('Null is not permitted in ' + table + '.' + col.name); continue; }
    let valid = false;
    switch (col.type) {
      case 'uuid': valid = typeof v === 'string' && UUID.test(v); break;
      case 'text': valid = typeof v === 'string' && !v.includes('\0'); break;
      case 'boolean': valid = typeof v === 'boolean'; break;
      case 'integer': case 'smallint': valid = typeof v === 'number' && Number.isSafeInteger(v); break;
      case 'bigint': valid = (typeof v === 'string' && /^(0|[1-9]\d*)$/.test(v)) || (typeof v === 'number' && Number.isSafeInteger(v) && v >= 0); break;
      case 'timestamp with time zone': valid = typeof v === 'string' && validTimestamp(v); break;
      case 'date': valid = typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v) && Number.isFinite(Date.parse(v + 'T00:00:00Z')) && new Date(v + 'T00:00:00Z').toISOString().slice(0,10) === v; break;
      case 'jsonb': valid = v !== undefined; break;
      case 'ARRAY': valid = Array.isArray(v) && v.every(n => typeof n === 'number' && Number.isSafeInteger(n)); break;
    }
    if (!valid) fail('Invalid value in ' + table + '.' + col.name);
  }
  if (table === 'core.settings' && !SETTINGS_KEYS.includes(String(row.key))) fail('Unsupported platform setting.');
  if (table === 'core.users') {
    if (!['user','admin'].includes(String(row.role)) || !['active','disabled'].includes(String(row.status)) || !USERNAME_PATTERN.test(String(row.username))) fail('Invalid account fields.');
    if (typeof row.password_hash !== 'string' || (!row.password_hash.startsWith('$argon2') && row.password_hash !== '!bootstrap-pending')) fail('Invalid account password representation.');
  }
  if (table === 'tasks.tasks' && !['todo','done'].includes(String(row.status))) fail('Invalid task status.');
  if (table === 'clock.world_clocks' && !isValidTimezone(String(row.timezone))) fail('Invalid world clock timezone.');
  if (table === 'mini_game.saves') {
    const board = row.board;
    // Existing SQL defaults and literal JSON null represent an inert save;
    // preserve their score metadata just as the App's defensive reader does.
    const inert = board === null || (Array.isArray(board) && board.length === 0);
    if (!inert && (!Array.isArray(board) || board.length !== 4 || !board.every(line =>
      Array.isArray(line) && line.length === 4 && line.every(value =>
        typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 &&
        (value === 0 || Number.isInteger(Math.log2(value))))))) fail('Invalid game board; expected a 4 by 4 grid of numeric tiles.');
  }
}
