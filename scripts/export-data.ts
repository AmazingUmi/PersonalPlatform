/** Export a previously restored/migrated isolated database into Settings JSON. */
import { writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { Database } from '../backend/src/core/database/index.js';
import { exportSnapshot, type Scope } from '../backend/src/core/data-management/snapshot.js';

async function main():Promise<void> {
  const args=new Map<string,string>();
  for(let i=2;i<process.argv.length;i+=2) {
    const name=process.argv[i], value=process.argv[i+1];
    if(!name||!['--database','--storage','--user','--scope','--output'].includes(name)||!value||args.has(name)) throw new Error('Usage: export-data.ts --database URL --storage PATH --user USERNAME --scope own|all --output FILE');
    args.set(name,value);
  }
  if(args.size!==5)throw new Error('All five explicit options are required; no production database or storage default is used.');
  const scope=args.get('--scope') as Scope;
  if(scope!=='own'&&scope!=='all')throw new Error('scope must be own or all');
  const db=new Database(args.get('--database')!);
  try {
    const user=(await db.query<{id:string;role:string}>('SELECT id,role FROM core.users WHERE username=$1',[args.get('--user')])).rows[0];
    if(!user)throw new Error('Requested source account does not exist.');
    const installedApps=(await db.query<{id:string}>('SELECT id FROM core.apps')).rows.map(r=>r.id);
    const snapshot=await exportSnapshot({database:db,storageRoot:resolve(args.get('--storage')!),actor:user,scope,installedApps});
    await writeFile(resolve(args.get('--output')!),JSON.stringify(snapshot),{flag:'wx',mode:0o600});
    console.log('Settings backup exported. Existing output files are never overwritten.');
  } finally {await db.close();}
}
main().catch(error=>{ console.error(error instanceof Error ? error.message.replace(/postgres(?:ql)?:\/\/\S+/g,'[database URL redacted]') : 'Export failed.'); process.exitCode=1; });
