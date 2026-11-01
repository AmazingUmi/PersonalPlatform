import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, it } from 'node:test';
import { randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, rm, readdir, symlink, writeFile, readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { resetDatabase, TEST_DATABASE_URL } from '../helpers/db.js';
import { ensureTestAdmin, createTestUser } from '../helpers/platform.js';
import { runAppMigrations } from '../../src/core/database/startup-migrations.js';
import type { Database, DatabaseContext } from '../../src/core/database/index.js';
import { createAppStorage } from '../../src/core/storage/local.js';
import { exportSnapshot, importSnapshot, previewSnapshot, type Snapshot, type Actor } from '../../src/core/data-management/snapshot.js';
import { TABLES } from '../../src/core/data-management/snapshot-schema.js';
let db:Database, root:string, admin:Actor, alice:Actor, bob:Actor;
const repo=resolve(import.meta.dirname,'../../..');
const bytes=Buffer.from([0,1,255,128,42]);
let item:string,attachment:string,note:string,tag:string,task:string;
const options=(actor=alice,scope:'own'|'all'='own')=>({database:db,storageRoot:root,actor,scope});
const clone=(snapshot:Snapshot):Snapshot=>JSON.parse(JSON.stringify(snapshot)) as Snapshot;
async function insertTask(user=alice.id,title='original'):Promise<string>{const id=randomUUID();await db.query('INSERT INTO tasks.tasks(id,user_id,title) VALUES($1,$2,$3)',[id,user,title]);return id;}
async function currentCount(table:string):Promise<number>{return Number((await db.query<{count:string}>('SELECT count(*) FROM '+table)).rows[0]!.count);}
before(async()=>{
  db=await resetDatabase(); admin={id:await ensureTestAdmin(db),role:'admin'};
  alice={id:(await createTestUser(db,'alice')).id,role:'user'};bob={id:(await createTestUser(db,'bob')).id,role:'user'};
  await runAppMigrations({databaseUrl:TEST_DATABASE_URL,manifestsDir:join(repo,'apps')});
  root=await mkdtemp(join(tmpdir(),'pp-snapshot-'));
});
beforeEach(async()=>{
  await db.query('TRUNCATE '+TABLES.filter(t=>!t.name.startsWith('core.')).map(t=>t.name).join(',')+' CASCADE');
  await db.query('DELETE FROM core.settings');
  await db.query('DELETE FROM core.users WHERE id<>ALL($1::uuid[])',[[admin.id,alice.id,bob.id]]);
  await rm(root,{recursive:true,force:true});await mkdir(root);
  task=await insertTask(); await insertTask(bob.id,'other user secret');
  item=randomUUID();attachment=randomUUID();note=randomUUID();tag=randomUUID();
  await db.query("INSERT INTO assets.items(id,user_id,name,acquired_at) VALUES($1,$2,'camera','2026-03-29')",[item,alice.id]);
  await db.query("INSERT INTO assets.attachments(id,user_id,item_id,filename,size,storage_key) VALUES($1,$2,$3,'binary.bin',$4,'original/file')",[attachment,alice.id,item,bytes.length]);
  await createAppStorage(root,'assets').forUser(alice.id).save('original/file',bytes);
  await db.query("INSERT INTO notes.notes(id,user_id,content,occurred_at) VALUES($1,$2,'note',now())",[note,alice.id]);
  await db.query("INSERT INTO notes.tags(id,user_id,name) VALUES($1,$2,'work')",[tag,alice.id]);
  await db.query('INSERT INTO notes.note_tags(note_id,tag_id) VALUES($1,$2)',[note,tag]);
});
after(async()=>{if(db)await db.close();if(root)await rm(root,{recursive:true,force:true});});

describe('Settings snapshot export and merge',()=>{
  it('exports only owner data and preserves binary/date values without credentials',async()=>{
    const snapshot=await exportSnapshot(options());
    assert.equal(snapshot.tables['tasks.tasks']!.length,1);
    assert.ok(!JSON.stringify(snapshot).includes('other user secret'));
    assert.ok(!('core.users' in snapshot.tables));
    assert.equal(snapshot.tables['assets.items']![0]!.acquired_at,'2026-03-29');
    assert.deepEqual(Buffer.from(snapshot.files[0]!.data,'base64'),bytes);
    const all=await exportSnapshot(options(admin,'all'));
    assert.equal(all.tables['tasks.tasks']!.length,2);assert.equal(all.tables['core.users']!.length,3);
    assert.ok(!('core.sessions' in all.tables));assert.ok(!('assets.cleanup_jobs' in all.tables));
    await assert.rejects(exportSnapshot(options(alice,'all')),/Administrator/);
  });
  it('preview rolls back and repeated merge preserves current records without extra files',async()=>{
    const snapshot=await exportSnapshot(options());
    await db.query('DELETE FROM tasks.tasks WHERE id=$1',[task]);
    const preview=await previewSnapshot({...options(),snapshot});assert.equal(preview.inserted,1);assert.equal(await currentCount('tasks.tasks'),1);
    const merged=await importSnapshot({...options(),snapshot});assert.equal(merged.inserted,1);
    await db.query("UPDATE tasks.tasks SET title='newer current' WHERE id=$1",[task]);
    const again=await importSnapshot({...options(),snapshot});assert.equal(again.inserted,0);assert.ok(again.skipped>0);
    assert.equal((await db.query('SELECT title FROM tasks.tasks WHERE id=$1',[task])).rows[0]!.title,'newer current');
    assert.deepEqual(await createAppStorage(root,'assets').forUser(alice.id).list(),['original/file']);
  });
  it('restores missing attachment to a new key and leaves previous file bytes unchanged',async()=>{
    const snapshot=await exportSnapshot(options());
    await db.query('DELETE FROM assets.attachments WHERE id=$1',[attachment]);
    await importSnapshot({...options(),snapshot});
    const key=String((await db.query('SELECT storage_key FROM assets.attachments WHERE id=$1',[attachment])).rows[0]!.storage_key);
    assert.ok(key.startsWith('imports/'));assert.notEqual(key,'original/file');
    assert.deepEqual(await createAppStorage(root,'assets').forUser(alice.id).read(key),bytes);
    assert.deepEqual(await createAppStorage(root,'assets').forUser(alice.id).read('original/file'),bytes);
    await importSnapshot({...options(),snapshot});assert.equal((await createAppStorage(root,'assets').forUser(alice.id).list()).length,2);
  });
  it('maps an own backup to the current account while rejecting UUID collisions with other users',async()=>{
    const snapshot=await exportSnapshot(options());
    await assert.rejects(importSnapshot({...options(bob),snapshot}),/different account/);
    await db.query('DELETE FROM tasks.tasks WHERE user_id=$1',[alice.id]);
    await db.query('DELETE FROM notes.notes WHERE user_id=$1',[alice.id]);await db.query('DELETE FROM notes.tags WHERE user_id=$1',[alice.id]);
    await db.query('DELETE FROM assets.items WHERE user_id=$1',[alice.id]);
    await importSnapshot({...options(bob),snapshot});
    assert.equal((await db.query('SELECT user_id FROM tasks.tasks WHERE id=$1',[task])).rows[0]!.user_id,bob.id);
    const row=(await db.query('SELECT * FROM assets.attachments WHERE id=$1',[attachment])).rows[0]!;
    assert.equal(row.user_id,bob.id);assert.deepEqual(await createAppStorage(root,'assets').forUser(bob.id).read(String(row.storage_key)),bytes);
  });
  it('remaps same-name tags and keeps associations',async()=>{
    const snapshot=await exportSnapshot(options());await db.query('DELETE FROM notes.tags WHERE id=$1',[tag]);
    const replacement=randomUUID();await db.query("INSERT INTO notes.tags(id,user_id,name) VALUES($1,$2,'work')",[replacement,alice.id]);
    await importSnapshot({...options(),snapshot});
    assert.deepEqual((await db.query('SELECT tag_id FROM notes.note_tags WHERE note_id=$1',[note])).rows.map(r=>r.tag_id),[replacement]);
    assert.equal(await currentCount('notes.tags'),1);
  });
  it('rejects source owner and relationship forgery and unknown columns before changing data',async()=>{
    const original=await exportSnapshot(options());
    const owner=clone(original);owner.tables['tasks.tasks']![0]!.user_id=bob.id;
    await assert.rejects(importSnapshot({...options(),snapshot:owner}),/more than one owner/);
    const refs=clone(original);refs.tables['notes.note_tags']![0]!.tag_id=randomUUID();
    await assert.rejects(importSnapshot({...options(),snapshot:refs}),/Missing parent/);
    const columns=clone(original);columns.tables['tasks.tasks']![0]!.evil='SQL';
    await assert.rejects(importSnapshot({...options(),snapshot:columns}),/fields/);
    assert.equal(await currentCount('tasks.tasks'),2);
  });
  it('rolls back earlier rows and cleans only newly created files on a late DB constraint failure',async()=>{
    const snapshot=await exportSnapshot(options());await db.query('DELETE FROM tasks.tasks WHERE id=$1',[task]);await db.query('DELETE FROM assets.attachments WHERE id=$1',[attachment]);
    // clock.alarms comes after attachment installation in deterministic order.
    const clockId=randomUUID();await db.query("INSERT INTO clock.alarms(id,user_id,time) VALUES($1,$2,'09:00')",[clockId,alice.id]);
    const clock=await exportSnapshot(options());snapshot.tables['clock.alarms']=clock.tables['clock.alarms']!;snapshot.tables['clock.alarms']![0]!.time='99:99';
    await db.query('DELETE FROM clock.alarms');
    await assert.rejects(importSnapshot({...options(),snapshot}),/constraint/);
    assert.equal(await currentCount('tasks.tasks'),1);assert.equal(await currentCount('assets.attachments'),0);
    assert.deepEqual(await createAppStorage(root,'assets').forUser(alice.id).list(),['original/file']);
  });
  it('retains committed attachment files when the COMMIT acknowledgement is lost',async()=>{
    const snapshot=await exportSnapshot(options());
    await db.query('DELETE FROM assets.attachments WHERE id=$1',[attachment]);
    await db.query('DELETE FROM tasks.tasks WHERE id=$1',[task]);
    const uncertainDb={withTransaction:async<T>(fn:(tx:DatabaseContext)=>Promise<T>):Promise<T>=>{
      await db.withTransaction(fn); // The server committed before the client lost its acknowledgement.
      throw new Error('simulated connection loss after commit');
    }} as unknown as Database;
    await assert.rejects(importSnapshot({...options(),database:uncertainDb,snapshot}),/commit result could not be confirmed/);
    const row=(await db.query('SELECT storage_key FROM assets.attachments WHERE id=$1',[attachment])).rows[0]!;
    assert.ok(row);
    assert.deepEqual(await createAppStorage(root,'assets').forUser(alice.id).read(String(row.storage_key)),bytes);
    assert.equal((await db.query('SELECT id FROM tasks.tasks WHERE id=$1',[task])).rows.length,1);
    assert.equal((await importSnapshot({...options(),snapshot})).inserted,0);
  });
  it('rejects an attachment symlink destination and missing source files',async()=>{
    const snapshot=await exportSnapshot(options());await db.query('DELETE FROM assets.attachments');
    const outside=await mkdtemp(join(tmpdir(),'pp-outside-'));
    try {await symlink(outside,join(root,'users',alice.id,'apps','assets','imports'));
      await assert.rejects(importSnapshot({...options(),snapshot}),/Unsafe attachment/);
      assert.equal((await readdir(outside)).length,0);
    }finally{await rm(outside,{recursive:true,force:true});}
    await db.query("INSERT INTO assets.attachments(id,user_id,item_id,filename,size,storage_key) VALUES($1,$2,$3,'missing',5,'missing')",[randomUUID(),alice.id,item]);
    await assert.rejects(exportSnapshot(options()),/could not be read/);
  });
  it('site merge preserves credentials and rejects partial identity matches',async()=>{
    const snapshot=await exportSnapshot(options(admin,'all'));
    const original=(await db.query('SELECT password_hash FROM core.users WHERE id=$1',[alice.id])).rows[0]!.password_hash;
    snapshot.tables['core.users']!.find(r=>r.id===alice.id)!.password_hash='!bootstrap-pending';
    await importSnapshot({...options(admin,'all'),snapshot});
    assert.equal((await db.query('SELECT password_hash FROM core.users WHERE id=$1',[alice.id])).rows[0]!.password_hash,original);
    const conflicting=clone(snapshot);conflicting.tables['core.users']!.find(r=>r.id===bob.id)!.username='alice';
    await assert.rejects(importSnapshot({...options(admin,'all'),snapshot:conflicting}),/Account ID or username/);
    await assert.rejects(importSnapshot({...options(alice),snapshot}),/scope/);
  });
  it('round-trips literal JSON null in a NOT NULL platform setting',async()=>{
    await db.query("INSERT INTO core.settings(key,value) VALUES('dashboard.widgets','null'::jsonb)");
    const snapshot=await exportSnapshot(options(admin,'all'));
    assert.equal(snapshot.tables['core.settings']![0]!.value,null);
    await db.query("DELETE FROM core.settings WHERE key='dashboard.widgets'");
    const preview=await previewSnapshot({...options(admin,'all'),snapshot});
    assert.equal(preview.inserted,1);
    assert.equal(await currentCount('core.settings'),0);
    const result=await importSnapshot({...options(admin,'all'),snapshot});
    assert.equal(result.inserted,1);
    const saved=(await db.query("SELECT value, value IS NULL AS sql_null FROM core.settings WHERE key='dashboard.widgets'")).rows[0]!;
    assert.equal(saved.value,null);
    assert.equal(saved.sql_null,false);
  });
  it('rejects active Focus conflicts atomically and serializes concurrent imports',async()=>{
    const id=randomUUID();await db.query("INSERT INTO focus.sessions(id,user_id,kind,status,planned_duration_seconds,started_at) VALUES($1,$2,'focus','running',1500,now())",[id,alice.id]);
    const snapshot=await exportSnapshot(options());snapshot.tables['focus.sessions']![0]!.id=randomUUID();
    await db.query('DELETE FROM tasks.tasks WHERE id=$1',[task]);
    await assert.rejects(importSnapshot({...options(),snapshot}),/active Focus/);
    assert.equal(await currentCount('tasks.tasks'),1);
    snapshot.tables['focus.sessions']=[];
    const reports=await Promise.all([importSnapshot({...options(),snapshot}),importSnapshot({...options(),snapshot})]);
    assert.equal(reports.reduce((n,r)=>n+r.inserted,0),1);
  });
  it('detects unknown app tables and incompatible column signatures',async()=>{
    const snapshot=await exportSnapshot(options());snapshot.schema['tasks.tasks']='wrong';
    await assert.rejects(importSnapshot({...options(),snapshot}),/incompatible/);
    await db.query('CREATE TABLE tasks.unknown_data(id integer)');
    try{await assert.rejects(exportSnapshot(options()),/No backup adapter/);}finally{await db.query('DROP TABLE tasks.unknown_data');}
  });
  it('rejects invalid world clock zones and nonnumeric game tiles before inserting any records',async()=>{
    const clock=randomUUID();
    await db.query("INSERT INTO clock.world_clocks(id,user_id,city,timezone,sort_order) VALUES($1,$2,'Singapore','Asia/Singapore',1)",[clock,alice.id]);
    await db.query("INSERT INTO mini_game.saves(id,user_id,board) VALUES('current',$1,$2::jsonb)",[alice.id,JSON.stringify(Array.from({length:4},()=>[0,0,0,0]))]);
    const original=await exportSnapshot(options());
    await db.query('DELETE FROM tasks.tasks WHERE id=$1',[task]);
    await db.query('DELETE FROM clock.world_clocks WHERE id=$1',[clock]);
    await db.query('DELETE FROM mini_game.saves WHERE user_id=$1',[alice.id]);
    const badZone=clone(original);badZone.tables['clock.world_clocks']![0]!.timezone='Invalid/Zone';
    await assert.rejects(previewSnapshot({...options(),snapshot:badZone}),/world clock timezone/);
    await assert.rejects(importSnapshot({...options(),snapshot:badZone}),/world clock timezone/);
    assert.equal(await currentCount('tasks.tasks'),1);assert.equal(await currentCount('clock.world_clocks'),0);
    const badBoard=clone(original);(badBoard.tables['mini_game.saves']![0]!.board as unknown[][])[0]![0]={tile:2};
    await assert.rejects(importSnapshot({...options(),snapshot:badBoard}),/game board/);
    assert.equal(await currentCount('tasks.tasks'),1);assert.equal(await currentCount('mini_game.saves'),0);
  });
  it('preserves high scores on inert default and JSON-null game saves',async()=>{
    await db.query("INSERT INTO mini_game.saves(id,user_id,high_score) VALUES('current',$1,2048)",[alice.id]);
    for(const board of [[],null]) {
      await db.query("UPDATE mini_game.saves SET board=$1::jsonb WHERE user_id=$2",[JSON.stringify(board),alice.id]);
      const snapshot=await exportSnapshot(options());
      assert.deepEqual(snapshot.tables['mini_game.saves']![0]!.board,board);
      await db.query('DELETE FROM mini_game.saves WHERE user_id=$1',[alice.id]);
      await previewSnapshot({...options(),snapshot});
      await importSnapshot({...options(),snapshot});
      const restored=(await db.query('SELECT board,high_score,board IS NULL AS sql_null FROM mini_game.saves WHERE user_id=$1',[alice.id])).rows[0]!;
      assert.deepEqual(restored.board,board);assert.equal(restored.high_score,2048);assert.equal(restored.sql_null,false);
    }
  });
  it('converts a trusted legacy CLI directory restored in the isolated test database',async()=>{
    const work=await mkdtemp(join(tmpdir(),'pp-legacy-data-'));
    try {
      await mkdir(join(work,'storage'));await mkdir(join(work,'apps'));await mkdir(join(work,'config'));await writeFile(join(work,'config','platform.yaml'),'platform:\n  name: restored\n');
      const {cp}=await import('node:fs/promises');await cp(root,join(work,'storage'),{recursive:true});
      function run(script:string,args:string[]):void{const r=spawnSync(process.execPath,['--import','tsx',join(repo,script),...args],{cwd:repo,encoding:'utf8'});assert.equal(r.status,0,r.stderr);}
      run('scripts/backup.ts',['create','--root',work,'--database',TEST_DATABASE_URL,'--output',join(work,'backups')]);
      const backup=join(work,'backups',(await readdir(join(work,'backups')))[0]!);
      await db.query('DELETE FROM tasks.tasks WHERE id=$1',[task]);
      run('scripts/backup.ts',['restore',backup,'--root',work,'--database',TEST_DATABASE_URL,'--yes']);
      run('scripts/export-data.ts',['--database',TEST_DATABASE_URL,'--storage',join(work,'storage'),'--user','alice','--scope','own','--output',join(work,'converted.json')]);
      const converted=JSON.parse(await readFile(join(work,'converted.json'),'utf8')) as Snapshot;
      assert.equal(converted.tables['tasks.tasks']![0]!.id,task);
      const report=await importSnapshot({...options(),snapshot:converted});assert.equal(report.inserted,0);
    }finally{await rm(work,{recursive:true,force:true});}
  });
});
