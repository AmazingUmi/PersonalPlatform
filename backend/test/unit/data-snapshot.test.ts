import assert from 'node:assert/strict';
import { test } from 'node:test';
import { randomUUID } from 'node:crypto';
import { digest, validateEnvelope, validateRow, type Snapshot } from '../../src/core/data-management/snapshot-schema.js';
const actor={id:randomUUID(),role:'user'};
function empty():Snapshot{return {type:'personal-platform-data',formatVersion:1,createdAt:new Date().toISOString(),scope:'own',source:{id:actor.id,username:'tester'},schema:{},tables:{},files:[]};}
test('scope and format are verified before accepting snapshot data',()=>{
  assert.throws(()=>validateEnvelope(empty(),actor,'all'),/Administrator/);
  assert.throws(()=>validateEnvelope({...empty(),scope:'all'},actor,'own'),/scope/);
  assert.throws(()=>validateEnvelope({...empty(),formatVersion:2},actor,'own'),/Unsupported/);
  assert.throws(()=>validateEnvelope('CREATE TABLE x()',actor,'own'),/Settings/);
});
test('unknown fields, tables and malformed attachment hashes fail',()=>{
  assert.throws(()=>validateEnvelope({...empty(),unknown:true},actor,'own'),/fields/);
  assert.throws(()=>validateEnvelope({...empty(),tables:{'core.users':[]}},actor,'own'),/Unsupported backup table/);
  const data=Buffer.from('file'); const file={attachmentId:randomUUID(),data:data.toString('base64'),sha256:digest(data)};
  assert.equal(validateEnvelope({...empty(),files:[file]},actor,'own').files.length,1);
  assert.throws(()=>validateEnvelope({...empty(),files:[{...file,data:'YmFk'}]},actor,'own'),/checksum/);
});
test('strict primitive/date validators reject type confusion and impossible dates',()=>{
  assert.throws(()=>validateRow({date:'2026-02-30'},[{name:'date',type:'date',nullable:false}],'test'),/Invalid value/);
  assert.throws(()=>validateRow({id:1},[{name:'id',type:'uuid',nullable:false}],'test'),/Invalid value/);
  assert.throws(()=>validateRow({v:null},[{name:'v',type:'text',nullable:false}],'test'),/Null/);
});
