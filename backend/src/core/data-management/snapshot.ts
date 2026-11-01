import { randomUUID } from 'node:crypto';
import { lstat, mkdir, open, unlink } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { AppError } from '../api/errors.js';
import type { Database, DatabaseContext } from '../database/index.js';
import { createAppStorage } from '../storage/local.js';
import { sanitizeKey } from '../storage/index.js';
import { APP_IDS, SETTINGS_KEYS, TABLES, MAX_SNAPSHOT_BYTES, MAX_SNAPSHOT_ROWS, authorize, digest, exactKeys, fail, keyOf, validateEnvelope, validateRow, type Actor, type Column, type Row, type Scope, type Snapshot, type TableSpec } from './snapshot-schema.js';
export { MAX_SNAPSHOT_BYTES } from './snapshot-schema.js';
export type { Actor, Scope, Snapshot } from './snapshot-schema.js';
export interface SnapshotOptions { database: Database; storageRoot: string; actor: Actor; scope: Scope; installedApps?: string[] }
export interface ImportOptions extends SnapshotOptions { snapshot: unknown }
export interface SnapshotReport { scope: Scope; createdAt: string; files: number; tables: {table: string; inserted: number; skipped: number; conflicts: number}[]; inserted: number; skipped: number }
interface Catalog { tables: TableSpec[]; columns: Map<string, Column[]>; signatures: Record<string,string> }
const quoted = (name: string): string => name.split('.').map(p => '"' + p + '"').join('.');

async function catalog(tx: DatabaseContext, installedApps: string[] = []): Promise<Catalog> {
  const schemas = [...new Set(['core', ...APP_IDS, ...installedApps])];
  const actual = (await tx.query<{schema: string; table: string}>(
    'SELECT table_schema AS schema, table_name AS table FROM information_schema.tables WHERE table_schema = ANY($1::text[]) AND table_type = $2', [schemas, 'BASE TABLE'])).rows;
  const names = actual.map(r => r.schema + '.' + r.table);
  for (const name of names) {
    if (name.startsWith('core.') || name.endsWith('.migrations') || name === 'assets.cleanup_jobs') continue;
    if (!TABLES.some(t => t.name === name)) fail('No backup adapter for table ' + name + '.');
  }
  const tables = TABLES.filter(t => names.includes(t.name));
  const columns = new Map<string, Column[]>(); const signatures: Record<string,string> = {};
  for (const table of tables) {
    const [schema, name] = table.name.split('.');
    const rows = (await tx.query<{name:string; type:string; nullable:boolean}>(
      'SELECT column_name AS name, data_type AS type, is_nullable = \'YES\' AS nullable FROM information_schema.columns WHERE table_schema=$1 AND table_name=$2 ORDER BY column_name', [schema,name])).rows;
    if (rows.map(r => r.name).join('|') !== [...table.columns].sort().join('|')) fail('Unsupported database schema for ' + table.name + '; upgrade or update its backup adapter.');
    columns.set(table.name, rows);
    signatures[table.name] = digest(Buffer.from(JSON.stringify(rows)));
  }
  return { tables, columns, signatures };
}
function relevant(table: TableSpec, scope: Scope): boolean { return scope === 'all' || !table.name.startsWith('core.'); }
function exportFilter(table: TableSpec, scope: Scope, actor: Actor): { sql: string; values: unknown[] } {
  if (table.name === 'core.settings') return {sql: ' WHERE t.key=ANY($1::text[])', values: [SETTINGS_KEYS]};
  if (scope === 'all') return {sql:'',values:[]};
  if (table.columns.includes('user_id')) return {sql:' WHERE t.user_id=$1',values:[actor.id]};
  const [column,parent] = Object.entries(table.parents ?? {})[0]!;
  return {sql:' WHERE EXISTS (SELECT 1 FROM ' + quoted(parent) + ' p WHERE p.id=t.' + quoted(column) + ' AND p.user_id=$1)', values:[actor.id]};
}
async function recheckActor(tx: DatabaseContext, actor: Actor, scope: Scope): Promise<{id:string;username:string}> {
  authorize(actor,scope);
  const user = (await tx.query<{id:string;username:string;role:string;status:string}>('SELECT id,username,role,status FROM core.users WHERE id=$1',[actor.id])).rows[0];
  if (!user || user.status !== 'active' || (scope === 'all' && user.role !== 'admin')) fail('Account is inactive or no longer permitted to manage this scope.',403);
  return {id:user.id,username:user.username};
}
export async function exportSnapshot(options: SnapshotOptions): Promise<Snapshot> {
  const {database,storageRoot,actor,scope} = options;
  authorize(actor,scope);
  return database.withTransaction(async tx => {
    await tx.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY');
    await tx.query("SET LOCAL statement_timeout = '30s'");
    await tx.query("SET LOCAL transaction_timeout = '120s'");
    const source = await recheckActor(tx,actor,scope);
    const cat = await catalog(tx,options.installedApps);
    const snapshot: Snapshot = {type:'personal-platform-data',formatVersion:1,createdAt:new Date().toISOString(),scope,source,schema:{},tables:{},files:[]};
    let bytes=0, count=0;
    for (const table of cat.tables.filter(t => relevant(t,scope))) {
      const filter=exportFilter(table,scope,actor);
      const estimated=(await tx.query<{count:string;bytes:string}>('SELECT count(*)::text AS count, coalesce(sum(octet_length(row_to_json(t)::text)),0)::text AS bytes FROM '+quoted(table.name)+' t'+filter.sql,filter.values)).rows[0]!;
      if(count+Number(estimated.count)>MAX_SNAPSHOT_ROWS || bytes+Number(estimated.bytes)>MAX_SNAPSHOT_BYTES) fail('Backup exceeds its row or 32 MiB limit.',413);
      const rows=(await tx.query<{data:string}>('SELECT row_to_json(t)::text AS data FROM ' + quoted(table.name) + ' t' + filter.sql + ' ORDER BY ' + table.key.map(k=>'t.'+quoted(k)).join(',') + ' LIMIT ' + (MAX_SNAPSHOT_ROWS+1),filter.values)).rows;
      count+=rows.length;
      if (count>MAX_SNAPSHOT_ROWS) fail('Database exceeds the snapshot row limit.',413);
      snapshot.tables[table.name]=rows.map(r=>{ bytes+=Buffer.byteLength(r.data); if(bytes>MAX_SNAPSHOT_BYTES) fail('Backup exceeds the 32 MiB limit.',413); return JSON.parse(r.data) as Row; });
      snapshot.schema[table.name]=cat.signatures[table.name]!;
    }
    for (const row of snapshot.tables['assets.attachments'] ?? []) {
      const key=String(row.storage_key); sanitizeKey(key);
      let data: Buffer;
      try { data=await createAppStorage(storageRoot,'assets').forUser(String(row.user_id)).read(key); }
      catch { fail('An attachment could not be read; no complete backup was produced. Retry after checking storage.'); }
      if (BigInt(String(row.size))!==BigInt(data.length)) fail('Attachment size differs from its metadata.');
      bytes+=Math.ceil(data.length/3)*4;
      if(bytes>MAX_SNAPSHOT_BYTES) fail('Backup exceeds the 32 MiB limit.',413);
      snapshot.files.push({attachmentId:String(row.id),sha256:digest(data),data:data.toString('base64')});
    }
    if(Buffer.byteLength(JSON.stringify(snapshot))>MAX_SNAPSHOT_BYTES) fail('Backup exceeds the 32 MiB limit.',413);
    validateSourceRelations(snapshot);
    return snapshot;
  });
}

function validateSourceRelations(snapshot: Snapshot): void {
  const byId = new Map<string,Map<unknown,Row>>();
  for(const [name,rows] of Object.entries(snapshot.tables)) byId.set(name,new Map(rows.map(r=>[r.id,r])));
  const owners=new Set((snapshot.tables['core.users']??[]).map(r=>r.id));
  for(const table of TABLES) for(const row of snapshot.tables[table.name]??[]) {
    if('user_id' in row && snapshot.scope==='all' && !owners.has(row.user_id)) fail('Missing account for an owned record.');
    const parents=Object.entries(table.parents??{}).map(([column,parent])=>{
      const record=byId.get(parent)?.get(row[column]);
      if(!record) fail('Missing parent record in '+table.name+'.');
      return record;
    });
    const userIds=[...parents.map(p=>p.user_id),...('user_id' in row?[row.user_id]:[])];
    if(userIds.length>1 && userIds.some(id=>id!==userIds[0])) fail('Cross-user relationship in backup.');
  }
  const attachments=snapshot.tables['assets.attachments']??[];
  if(snapshot.files.length!==attachments.length) fail('Attachment metadata and file counts differ.');
  const files=new Map(snapshot.files.map(f=>[f.attachmentId,f]));
  for(const row of attachments) {
    const file=files.get(String(row.id));
    if(!file || BigInt(String(row.size))!==BigInt(Buffer.from(file.data,'base64').length)) fail('Missing attachment or incorrect file size.');
    try { if(sanitizeKey(String(row.storage_key))!==row.storage_key) fail('Noncanonical attachment storage key.'); } catch { fail('Unsafe attachment storage key.'); }
  }
}

class PreviewRollback extends Error { constructor(readonly report:SnapshotReport){super('preview rollback');} }
/** New files use unpredictable keys and exclusive create. Check every descendant for symlinks. */
async function saveNewFile(root:string,userId:string,data:Buffer):Promise<{key:string;path:string}> {
  const key='imports/'+randomUUID();
  let current=resolve(root);
  await mkdir(current,{recursive:true});
  // Configured storage root can be an operator-provided mount/symlink, but no
  // descendant (including a user/app root) may redirect the write.
  for(const part of ['users',userId,'apps','assets','imports']) {
    current=join(current,part);
    try {await mkdir(current);} catch(error){if((error as NodeJS.ErrnoException).code!=='EEXIST') throw error;}
    const info=await lstat(current);
    if(!info.isDirectory()||info.isSymbolicLink()) fail('Unsafe attachment storage directory.');
  }
  const path=join(current,key.split('/')[1]!);
  const handle=await open(path,'wx',0o600);
  try {await handle.writeFile(data);} catch(error){await handle.close(); await unlink(path).catch(()=>undefined); throw error;}
  await handle.close(); return {key,path};
}
function cloneRow(row:Row):Row{return {...row};}
async function existingRows(tx:DatabaseContext,table:TableSpec,rows:Row[],options:SnapshotOptions):Promise<Row[]> {
  if(!rows.length)return [];
  const values:unknown[]=[];
  const any=(column:string,items:unknown[],type:string):string=>{values.push([...new Set(items)]);return quoted(column)+'=ANY($'+values.length+'::'+type+'[])';};
  const owners=rows.map(r=>options.scope==='own'?options.actor.id:r.user_id);
  const conditions:string[]=[];
  if(table.columns.includes('id'))conditions.push(any('id',rows.map(r=>r.id),table.key.includes('user_id')?'text':'uuid'));
  else if(table.name==='core.settings')conditions.push(any('key',rows.map(r=>r.key),'text'));
  else {
    // Relationship IDs may be remapped by natural-key merging. Select by
    // either parent ID to include the destination relation after remapping.
    for(const column of table.key)conditions.push(any(column,rows.map(r=>r[column]),'uuid'));
  }
  if(table.name==='core.users')conditions.push(any('username',rows.map(r=>r.username),'text'));
  if(table.natural)conditions.push('('+any('user_id',owners,'uuid')+' AND '+any(table.natural,rows.map(r=>r[table.natural!]),'text')+')');
  if(table.name==='focus.sessions')conditions.push('('+any('user_id',owners,'uuid')+" AND status IN ('running','paused'))");
  // Current content can be much larger than incoming content; only identity
  // and ownership columns are needed when existing rows are preserved.
  const columns=[...new Set([...table.key,...['id','user_id','username','status',table.natural].filter((c):c is string=>!!c&&table.columns.includes(c))])];
  const result=(await tx.query<Row>('SELECT '+columns.map(quoted).join(',')+' FROM '+quoted(table.name)+' WHERE '+conditions.join(' OR ')+' LIMIT '+(MAX_SNAPSHOT_ROWS+1),values)).rows;
  if(result.length>MAX_SNAPSHOT_ROWS)fail('Too many matching destination records; merge a smaller backup.',413);
  return result;
}

async function merge(options:ImportOptions,preview:boolean):Promise<SnapshotReport> {
  const snapshot=validateEnvelope(options.snapshot,options.actor,options.scope);
  const createdFiles:string[]=[];
  let bodyCompleted=false;
  try {
    return await options.database.withTransaction(async tx=>{
      await tx.query("SET LOCAL lock_timeout = '5s'");
      await tx.query("SET LOCAL statement_timeout = '30s'");
      await tx.query("SET LOCAL transaction_timeout = '120s'");
      const cat=await catalog(tx,options.installedApps);
      const requested=TABLES.filter(t=>Object.hasOwn(snapshot.tables,t.name));
      for(const table of requested) {
        if(!cat.tables.some(t=>t.name===table.name)||snapshot.schema[table.name]!==cat.signatures[table.name]) fail('Backup schema is incompatible with '+table.name+'. Convert it with the current migrations first.');
        for(const row of snapshot.tables[table.name]!) validateRow(row,cat.columns.get(table.name)!,table.name);
      }
      validateSourceRelations(snapshot);
      // Stable lock order blocks ordinary App writes too, so preserved rows,
      // unique names and parent ownership cannot change between check/insert.
      const locks=[...new Set(['core.users',...requested.map(t=>t.name)])].sort();
      await tx.query('LOCK TABLE '+locks.map(quoted).join(',')+' IN SHARE ROW EXCLUSIVE MODE');
      await recheckActor(tx,options.actor,options.scope);
      const report:SnapshotReport={scope:snapshot.scope,createdAt:snapshot.createdAt,files:snapshot.files.length,tables:[],inserted:0,skipped:0};
      const maps=new Map<string,Map<unknown,unknown>>();
      const targetRows=new Map<string,Map<string,Row>>();
      const fileMap=new Map(snapshot.files.map(f=>[f.attachmentId,f]));
      for(const table of requested) {
        const lookupRows=snapshot.tables[table.name]!.map(source=>{const row={...source};for(const [column,parent] of Object.entries(table.parents??{}))row[column]=maps.get(parent)?.get(row[column])??row[column];return row;});
        const existing=await existingRows(tx,table,lookupRows,options);
        const targets=new Map(existing.map(r=>[keyOf(r,table.key),r]));targetRows.set(table.name,targets);
        const idMap=new Map<unknown,unknown>(); maps.set(table.name,idMap);
        const stat={table:table.name,inserted:0,skipped:0,conflicts:0};report.tables.push(stat);
        for(const incoming of snapshot.tables[table.name]!) {
          const row=cloneRow(incoming);
          if(options.scope==='own'&&'user_id' in row) row.user_id=options.actor.id;
          for(const [column,parent] of Object.entries(table.parents??{})) {
            const mapped=maps.get(parent)?.get(row[column]);
            if(mapped===undefined) fail('Missing imported parent mapping.');
            row[column]=mapped;
          }
          const targetKey=keyOf(row,table.key);
          let old=targets.get(targetKey);
          if(old && 'user_id' in row && old.user_id!==row.user_id) fail('A record ID belongs to a different account; the whole merge was cancelled.',409);
          if(table.name==='core.users') {
            const named=existing.find(r=>r.username===row.username);
            if((old&&old.username!==row.username)||(named&&named.id!==row.id)) fail('Account ID or username conflicts with an existing account; the whole merge was cancelled.',409);
          }
          if(!old&&table.natural) old=[...targets.values()].find(r=>r.user_id===row.user_id&&r[table.natural!]===row[table.natural!]);
          if(old) {if('id' in row)idMap.set(row.id,old.id);stat.skipped++;report.skipped++;continue;}
          // Imported parent identities must still refer to the same owner in
          // the destination even when existing parent rows were preserved.
          const parentOwners=Object.entries(table.parents??{}).map(([column,parent])=>{
            const parentSpec=TABLES.find(t=>t.name===parent)!;
            const parentRow=targetRows.get(parent)?.get(keyOf({id:row[column]},parentSpec.key));
            if(!parentRow) fail('Missing destination parent.');return parentRow.user_id;
          });
          if('user_id' in row)parentOwners.push(row.user_id);
          if(parentOwners.length>1&&parentOwners.some(id=>id!==parentOwners[0]))fail('Destination ownership conflict.',409);
          if(table.name==='focus.sessions'&&['running','paused'].includes(String(row.status))&&[...targets.values()].some(r=>r.user_id===row.user_id&&['running','paused'].includes(String(r.status)))) fail('An active Focus session already exists; finish it before merging this backup.',409);
          if(table.name==='assets.attachments') {
            if(preview)row.storage_key='imports/'+randomUUID();
            else {const file=await saveNewFile(options.storageRoot,String(row.user_id),Buffer.from(fileMap.get(String(row.id))!.data,'base64'));row.storage_key=file.key;createdFiles.push(file.path);}
          }
          const columns=table.columns;
          const types=cat.columns.get(table.name)!;
          const values=columns.map(col=>types.find(c=>c.name===col)!.type==='jsonb'?JSON.stringify(row[col]):row[col]);
          await tx.query('INSERT INTO '+quoted(table.name)+' ('+columns.map(quoted).join(',')+') VALUES ('+columns.map((_,i)=>'$'+(i+1)).join(',')+')',values);
          targets.set(targetKey,row);existing.push(row);if('id' in row)idMap.set(incoming.id,row.id);
          stat.inserted++;report.inserted++;
        }
      }
      if(preview)throw new PreviewRollback(report);
      bodyCompleted=true;
      return report;
    });
  } catch(error) {
    // Once the callback returns, withTransaction is waiting for COMMIT. A
    // dropped connection can lose the acknowledgement after PostgreSQL has
    // committed; deleting staged files here would corrupt committed rows.
    // Keep them and report uncertainty. Retrying the same snapshot is safe.
    if(bodyCompleted)throw new AppError(503,'import_outcome_unknown','The database commit result could not be confirmed. New attachment files were retained. Reload to inspect the result, then retry the same backup if needed; merging is idempotent.');
    const failed:string[]=[];
    for(const path of createdFiles)try{await unlink(path);}catch{failed.push(path);}
    if(failed.length)throw new AppError(500,'import_cleanup_required','Database import failed; unreferenced new attachment files require cleanup.',{paths:failed});
    if(error instanceof PreviewRollback)return error.report;
    if(error instanceof AppError)throw error;
    const code=(error as {code?:string}).code;
    if(code==='55P03'||code==='40P01'||code==='57014')throw new AppError(409,'import_busy','Data is busy; no records were merged. Retry shortly.');
    if(code?.startsWith('23')||code?.startsWith('22'))fail('The backup violates a database constraint; no records were merged.',409);
    throw error;
  }
}
export function previewSnapshot(options:ImportOptions):Promise<SnapshotReport>{return merge(options,true);}
export function importSnapshot(options:ImportOptions):Promise<SnapshotReport>{return merge(options,false);}
