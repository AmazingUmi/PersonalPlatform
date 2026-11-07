import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync, rmSync, chmodSync, statSync, symlinkSync, renameSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { gzipSync } from 'node:zlib';
import { after, test } from 'node:test';

const repository = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const script = join(repository, 'scripts/deploy.sh');
const temporary = realpathSync(mkdtempSync(join(tmpdir(), 'pp-deploy-unit-')));
after(() => rmSync(temporary, { recursive: true, force: true }));
const bash = existsSync('/opt/homebrew/bin/bash') ? '/opt/homebrew/bin/bash' : '/bin/bash';
const digest = c => `sha256:${c.repeat(64)}`;
const hash = value => createHash('sha256').update(value).digest('hex');
let sequence = 0;

// Small USTAR fixtures let malformed paths/types be tested without depending
// on the test host's tar implementation to create unsafe archives.
function archive(entries) {
  const blocks = [];
  for (const entry of entries) {
    const data = Buffer.from(entry.body ?? '');
    const header = Buffer.alloc(512);
    header.write(entry.name, 0, 100);
    for (const [offset, length, value] of [[100, 8, 0o600], [108, 8, 0], [116, 8, 0], [124, 12, data.length], [136, 12, 0]]) {
      header.write(value.toString(8).padStart(length - 1, '0') + '\0', offset, length);
    }
    header.fill(32, 148, 156);
    header.write(entry.type ?? '0', 156, 1);
    if (entry.link) header.write(entry.link, 157, 100);
    header.write('ustar\0', 257, 6); header.write('00', 263, 2);
    const checksum = [...header].reduce((sum, byte) => sum + byte, 0);
    header.write(checksum.toString(8).padStart(6, '0') + '\0 ', 148, 8);
    blocks.push(header, data, Buffer.alloc((512 - data.length % 512) % 512));
  }
  return gzipSync(Buffer.concat([...blocks, Buffer.alloc(1024)]));
}
function bundle(folder, version = 'v0.1.0', options = {}) {
  mkdirSync(folder, { recursive: true });
  const references = {
    backend: `ghcr.io/amazingumi/personalplatform-backend@${digest('a')}`,
    frontend: `ghcr.io/amazingumi/personalplatform-frontend@${digest('b')}`,
  };
  const files = {
    '.env.release.example': readFileSync(join(repository, '.env.release.example'), 'utf8').replace(/^BACKEND_IMAGE=.*$/m, `BACKEND_IMAGE=${references.backend}`).replace(/^FRONTEND_IMAGE=.*$/m, `FRONTEND_IMAGE=${references.frontend}`),
    'release.json': JSON.stringify({ version, revision: 'c'.repeat(40), platforms: ['linux/amd64', 'linux/arm64'], images: Object.fromEntries(Object.entries(references).map(([service, reference]) => [service, { reference }])) }),
    'README.md': 'Installation instructions\n',
    'docker/docker-compose.release.yml': readFileSync(join(repository, 'docker/docker-compose.release.yml'), 'utf8'),
    'docker/docker-compose.runtime.yml': readFileSync(join(repository, 'docker/docker-compose.runtime.yml'), 'utf8'),
    'deploy.sh': '#!/usr/bin/env bash\n',
  };
  if (options.lookalike) files['.env.release.example'] = files['.env.release.example'].replace('ghcr.io/', 'ghcrXio/');
  const checksums = Object.entries(files).map(([name, body]) => `${hash(body)}  ${name}\n`).join('');
  if (options.badInternal) files['README.md'] = 'changed after checksum\n';
  files.SHA256SUMS = checksums;
  const root = `personalplatform-${version}`;
  const entries = Object.entries(files).map(([name, body]) => ({ name: `${root}/${name}`, body }));
  if (options.extra) entries.push(options.extra);
  if (options.link) { const readme = entries.find(entry => entry.name.endsWith('/README.md')); readme.type = '2'; readme.link = '/tmp/private-target'; readme.body = ''; }
  const bytes = archive(entries);
  const name = `${root}.tar.gz`;
  writeFileSync(join(folder, name), bytes);
  writeFileSync(join(folder, 'SHA256SUMS'), `${options.badExternal ? '0'.repeat(64) : hash(bytes)}  ${name}\n`);
  return folder;
}
const dockerFixture = String.raw`
const fs=require('fs'),path=require('path'),cp=require('child_process');const root=process.env.DOCKER_TEST_ROOT,args=process.argv.slice(2);
const line={args,ambientProject:process.env.COMPOSE_PROJECT_NAME??null,ambientPassword:process.env.POSTGRES_PASSWORD===undefined?'cleared':'present'};
fs.appendFileSync(path.join(root,'calls'),JSON.stringify(line)+'\n');
if(args[0]==='info')process.exit(process.env.DOCKER_TEST_INFO_FAIL==='1'?1:0);
if(args[0]==='pull')process.exit(process.env.DOCKER_TEST_PULL_FAIL==='1'?7:0);
if(args[0]==='run'){
 const index=args.indexOf('-e');if(index>=0){const result=cp.spawnSync(process.execPath,['-e',args[index+1],...args.slice(index+2)],{input:fs.readFileSync(0),encoding:'utf8'});process.stdout.write(result.stdout??'');process.stderr.write(result.stderr??'');process.exit(result.status??1);}process.exit(1);
}
if(args[0]==='inspect'&&process.env.DOCKER_TEST_SUCCESS==='1'){
 const saved=JSON.parse(fs.readFileSync(path.join(root,'running'),'utf8'));
 const input=args.slice(1).map(id=>{const service=id.replace('container-','');const volume=service==='database'?'postgres-data':'app-storage';return {Id:id,Image:'sha256:'+({backend:'a',frontend:'b',database:'d'}[service].repeat(64)),Config:{Labels:{'com.docker.compose.project':saved.project,'com.docker.compose.service':service,'com.docker.compose.project.config_files':saved.file}},State:{Running:true,Health:{Status:'healthy'}},Mounts:service==='frontend'?[]:[{Type:'volume',Name:saved.project+'_'+volume,Destination:service==='database'?'/var/lib/postgresql/data':'/workspace/storage'}]};});console.log(JSON.stringify(input));process.exit(0);
}
if(args[0]==='volume'&&args[1]==='inspect'&&process.env.DOCKER_TEST_SUCCESS==='1'&&!args[2].endsWith('_deploy-owner')){
 const saved=JSON.parse(fs.readFileSync(path.join(root,'running'),'utf8'));
 console.log(JSON.stringify(args.slice(2).map(name=>({Name:name,CreatedAt:'2026-01-01T00:00:00Z',Driver:'local',Options:null,Labels:{'com.docker.compose.project':saved.project,'com.docker.compose.volume':name===saved.project+'_postgres-data'?'postgres-data':'app-storage'}}))));process.exit(0);
}
if(args[0]==='volume'&&args[1]==='create'){
 const name=args.at(-1),labels={};for(let i=0;i<args.length;i++)if(args[i]==='--label'){const value=args[++i],at=value.indexOf('=');labels[value.slice(0,at)]=value.slice(at+1);}
 const claim=path.join(root,'claim');try{fs.writeFileSync(claim,JSON.stringify({Name:name,Labels:labels}),{flag:'wx'});}catch(e){if(e.code!=='EEXIST')throw e;}console.log(name);process.exit(0);
}
if(args[0]==='volume'&&args[1]==='inspect'&&args[2].endsWith('_deploy-owner')){
 const value=JSON.parse(fs.readFileSync(path.join(root,'claim'),'utf8'));if(process.env.DOCKER_TEST_FOREIGN_OWNER==='1')value.Labels['io.personalplatform.deploy.owner']='f'.repeat(32);console.log(JSON.stringify([value]));process.exit(0);
}
if(args[0]==='volume'&&args[1]==='ls'){if(process.env.DOCKER_TEST_COLLISION==='volume')console.log('unit-project_app-storage');else if(process.env.DOCKER_TEST_SUCCESS==='1'&&fs.existsSync(path.join(root,'running'))){const saved=JSON.parse(fs.readFileSync(path.join(root,'running'),'utf8'));console.log(saved.project+'_postgres-data\n'+saved.project+'_app-storage');}process.exit(0);}
if(args[0]==='ps'){if(process.env.DOCKER_TEST_COLLISION==='container')console.log('foreign-container');else if(process.env.DOCKER_TEST_SUCCESS==='1'&&fs.existsSync(path.join(root,'running')))console.log('container-database\ncontainer-backend\ncontainer-frontend');process.exit(0);}
if(args[0]==='compose'&&args[1]==='version'){console.log(process.env.DOCKER_TEST_COMPOSE_VERSION??'2.24.0');process.exit(0);}
if(args[0]==='compose'){
 const env=fs.readFileSync(args[args.indexOf('--env-file')+1],'utf8'),values={};for(const line of env.split('\n')){const match=line.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);if(!match)continue;let value=match[2];if((value.startsWith("'")&&value.endsWith("'"))||(value.startsWith('"')&&value.endsWith('"')))value=value.slice(1,-1);values[match[1]]=value;}
 const project=args[args.indexOf('--project-name')+1];
 if(args.includes('config')){
 const config={name:project,services:{database:{image:'postgres:17-alpine',environment:{POSTGRES_PASSWORD:values.POSTGRES_PASSWORD},volumes:[{type:'volume',source:'postgres-data',target:'/var/lib/postgresql/data'}]},backend:{image:values.BACKEND_IMAGE,environment:{PLATFORM_ENVIRONMENT:'production',POSTGRES_PASSWORD:values.POSTGRES_PASSWORD,BOOTSTRAP_ADMIN_USERNAME:values.BOOTSTRAP_ADMIN_USERNAME,BOOTSTRAP_ADMIN_PASSWORD:values.BOOTSTRAP_ADMIN_PASSWORD},volumes:[{type:'volume',source:'app-storage',target:'/workspace/storage'}]},frontend:{image:values.FRONTEND_IMAGE,ports:[{target:8080,published:values.FRONTEND_PORT||'5173'}]}},volumes:{'postgres-data':{name:project+'_postgres-data'},'app-storage':{name:project+'_app-storage'}}};console.log(JSON.stringify(config));process.exit(0);
 }
 if(args.includes('up')){fs.writeFileSync(path.join(root,'unexpected-up'),'yes');if(process.env.DOCKER_TEST_SUCCESS==='1'){fs.writeFileSync(path.join(root,'running'),JSON.stringify({project,file:args[args.indexOf('-f')+1]}));process.exit(0);}process.exit(91);}
 if(args.includes('ps')&&process.env.DOCKER_TEST_SUCCESS==='1'){for(const service of ['database','backend','frontend'])if(args.includes(service))console.log('container-'+service);process.exit(0);}
 if(args.includes('port')){console.log('127.0.0.1:5173');process.exit(0);}
 process.exit(0);
}
process.exit(1);
`;
function fixture(options = {}) {
  const root = join(temporary, `case-${++sequence}`), bin = join(root, 'bin');
  mkdirSync(bin, { recursive: true });
  const executable = (name, body) => { const file = join(bin, name); writeFileSync(file, body); chmodSync(file, 0o755); };
  executable('uname', '#!/bin/sh\nprintf "Linux\\n"\n');
  executable('flock', '#!/bin/sh\nif [ \"${DOCKER_TEST_COMMAND_LOCK_FAIL:-0}\" = 1 ] && [ \"$2\" = 7 ]; then exit 1; fi\nexit 0\n'); // Real kernel locking is verified in Linux runtime acceptance.
  executable('sync', '#!/bin/sh\nexit 0\n');
  executable('docker', `#!${process.execPath}\n${dockerFixture}`);
  executable('realpath', `#!${process.execPath}\nconst fs=require('fs'),p=require('path'),a=process.argv.slice(2),v=a.at(-1);console.log(a.includes('-e')?fs.realpathSync(v):p.resolve(v));\n`);
  if (process.platform !== 'linux') {
    for (const name of ['chmod', 'mkdir']) executable(name, `#!${process.execPath}\nconst cp=require('child_process');const r=cp.spawnSync('/bin/${name}',process.argv.slice(2).filter(x=>x!=='--'),{stdio:'inherit'});process.exit(r.status??1);\n`);
  }
  executable('rm', `#!${process.execPath}\nconst cp=require('child_process'),a=process.argv.slice(2).filter(x=>process.platform==='linux'||x!=='--');if(process.env.DOCKER_TEST_FAIL_COMMAND_CLEANUP==='1'&&a.some(x=>x.includes('/.pp.new.')))process.exit(77);const r=cp.spawnSync('/bin/rm',a,{stdio:'inherit'});process.exit(r.status??1);\n`);
  executable('cp', `#!${process.execPath}\nconst cp=require('child_process'),a=process.argv.slice(2).filter(x=>process.platform==='linux'||x!=='--');if(process.env.DOCKER_TEST_FAIL_INSTALLER_SAVE==='1'&&a.at(-1).includes('/.deploy/deploy.new.'))process.exit(74);const r=cp.spawnSync('/bin/cp',a,{stdio:'inherit'});process.exit(r.status??1);\n`);
  executable('stat', `#!${process.execPath}\nconst fs=require('fs'),cp=require('child_process'),a=process.argv.slice(2),file=a.at(-1);if(a[0]==='-c'&&a[1]==='%u'&&file===process.env.DOCKER_TEST_COMMAND_PARENT&&process.env.DOCKER_TEST_COMMAND_PARENT_OWNER){console.log(process.env.DOCKER_TEST_COMMAND_PARENT_OWNER);process.exit(0);}if(process.platform!=='linux'&&a[0]==='-c'&&['%a','%u'].includes(a[1])){const s=fs.statSync(file);console.log(a[1]==='%a'?(s.mode&0o7777).toString(8):s.uid);process.exit(0);}const r=cp.spawnSync('/usr/bin/stat',a,{stdio:'inherit'});process.exit(r.status??1);\n`);
  executable('tar', `#!${process.execPath}\nconst cp=require('child_process');const args=process.argv.slice(2).filter(x=>process.platform==='linux'||x!=='--quoting-style=escape');const r=cp.spawnSync('/usr/bin/tar',args,{stdio:'inherit'});process.exit(r.status??1);\n`);
  executable('mv', `#!${process.execPath}\nconst cp=require('child_process'),a=process.argv.slice(2).filter(x=>x!=='--'&&(process.platform==='linux'||x!=='-T')),publish=a.at(-1).endsWith('/.deploy/pending');if(process.env.DOCKER_TEST_FAIL_COMMAND_PUBLISH==='1'&&a.at(-1)===process.env.DOCKER_TEST_COMMAND_DIR+'/pp')process.exit(75);if(process.env.DOCKER_TEST_FAIL_COMMAND_RECORD==='1'&&a.at(-1).endsWith('/.deploy/command.sha256'))process.exit(76);if(publish&&process.env.DOCKER_TEST_KILL_JOURNAL==='before'){process.kill(process.ppid,'SIGKILL');process.exit(9);}const r=cp.spawnSync('/bin/mv',a,{stdio:'inherit'});if(a.at(-1).endsWith('/.deploy/active')&&r.status===0&&process.env.DOCKER_TEST_KILL_ACTIVE==='1')process.kill(process.ppid,'SIGKILL');if(publish&&r.status===0&&process.env.DOCKER_TEST_KILL_JOURNAL==='after')process.kill(process.ppid,'SIGKILL');process.exit(r.status??1);\n`);
  executable('curl', `#!${process.execPath}\nconst fs=require('fs'),p=require('path'),a=process.argv.slice(2);fs.appendFileSync(p.join(process.env.DOCKER_TEST_ROOT,'downloads'),JSON.stringify(a)+'\\n');if(process.env.DOCKER_TEST_DOWNLOAD_FAIL==='1')process.exit(22);if(a.includes('%{url_effective}')){console.log('https://github.com/AmazingUmi/PersonalPlatform/releases/tag/v0.1.0');process.exit(0);}const output=a[a.indexOf('-o')+1],url=a.find(v=>v.startsWith('https://'));fs.copyFileSync(p.join(process.env.DOCKER_TEST_ASSETS,url.split('/').at(-1)),output);\n`);
  const target = join(root, options.targetName ?? 'install'), commandDir = join(root, options.commandName ?? 'commands'), assets = bundle(join(root, 'assets'));
  const env = { ...process.env, PATH: `${bin}:${process.env.PATH}`, DOCKER_TEST_ROOT: root, DOCKER_TEST_ASSETS: assets, DOCKER_TEST_COMMAND_DIR: commandDir, COMPOSE_PROJECT_NAME: 'ambient-wrong-project', POSTGRES_PASSWORD: 'ambient-must-not-win' };
  return { root, target, assets, commandDir, command: join(commandDir, 'pp'), env, run: (args = [], overrides = {}) => spawnSync(bash, [script, '--dir', target, '--command-dir', commandDir, ...args], { encoding: 'utf8', env: { ...env, ...overrides }, timeout: 30_000 }), runSaved: (args = [], overrides = {}) => spawnSync(bash, [script, '--dir', target, ...args], { encoding: 'utf8', env: { ...env, ...overrides }, timeout: 30_000 }), launch: (args = [], overrides = {}, cwd = '/') => spawnSync(bash, [join(commandDir, 'pp'), ...args], { encoding: 'utf8', env: { ...env, ...overrides }, cwd, timeout: 30_000 }), calls: () => existsSync(join(root, 'calls')) ? readFileSync(join(root, 'calls'), 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line)) : [] };
}
function privateEnv(f, password = 'private-admin-password') {
  const file = join(f.root, 'private.env');
  writeFileSync(file, `COMPOSE_PROJECT_NAME=unit-project\nPOSTGRES_DB=pp\nPOSTGRES_USER=pp\nPOSTGRES_PASSWORD='${password}'\nBOOTSTRAP_ADMIN_USERNAME=unit-admin\nBOOTSTRAP_ADMIN_PASSWORD='${password}'\n`);
  chmodSync(file, 0o600); return file;
}
function assertNoStartup(f) {
  assert.ok(!existsSync(join(f.root, 'unexpected-up')));
  assert.ok(!f.calls().some(call => call.args.includes('stop') || call.args.includes('up') || call.args.includes('start')));
}

test('CLI rejects unstable versions, incomplete options and normalized filesystem root before Docker', () => {
  for (const args of [['--version', 'latest'], ['--version', 'v01.0.0'], ['--version', 'v0.1.0-rc.1'], ['--bundle-dir', '/tmp'], ['--version'], ['--dir', '/opt/..', '--adopt']]) {
    const f = fixture(), result = f.run(args); assert.notEqual(result.status, 0, args.join(' ')); assert.equal(f.calls().length, 0);
  }
});
test('status is read-only and refuses nonexistent/unmanaged targets', () => {
  const f = fixture(); assert.notEqual(f.run(['--status']).status, 0); assert.equal(existsSync(f.target), false);
  mkdirSync(f.target); writeFileSync(join(f.target, 'unrelated'), 'preserve'); assert.notEqual(f.run(['--status']).status, 0); assert.deepEqual(readdirSync(f.target), ['unrelated']);
  mkdirSync(join(f.target, '.deploy')); writeFileSync(join(f.target, '.deploy/managed'), '1\n'); writeFileSync(join(f.target, '.deploy/active'), 'v0.1.0\n'); writeFileSync(join(f.target, '.deploy.lock'), ''); chmodSync(f.target, 0o750);
  const result = f.run(['--status']); assert.equal(result.status, 0, result.stderr); assert.match(result.stdout, /v0.1.0/); assert.equal(statSync(f.target).mode & 0o777, 0o750); assert.equal(f.calls().length, 0);
});
test('unmanaged nonempty installation targets are not taken over implicitly', () => {
  const f = fixture(); mkdirSync(f.target); writeFileSync(join(f.target, 'existing-data'), 'data'); const result = f.run(['--version', 'v0.1.0']); assert.notEqual(result.status, 0); assert.match(result.stderr, /not managed/); assert.equal(readFileSync(join(f.target, 'existing-data'), 'utf8'), 'data'); assertNoStartup(f);
});
test('missing Docker and old Compose versions fail before download or startup', () => {
  for (const overrides of [{ DOCKER_TEST_INFO_FAIL: '1' }, { DOCKER_TEST_COMPOSE_VERSION: '2.19.9' }]) {
    const f = fixture(); const result = f.run(['--version', 'v0.1.0'], overrides); assert.notEqual(result.status, 0); assertNoStartup(f); assert.ok(!f.calls().some(call => call.args[0] === 'pull'));
  }
});
test('HTTP and external archive checksum failures leave previous accepted state unchanged', () => {
  for (const kind of ['http', 'checksum']) {
    const f = fixture(); mkdirSync(join(f.target, '.deploy'), { recursive: true }); writeFileSync(join(f.target, '.deploy/managed'), '1\n'); writeFileSync(join(f.target, '.deploy/active'), 'v0.0.9\n');
    if (kind === 'checksum') bundle(f.assets, 'v0.1.0', { badExternal: true });
    const result = f.run(['--version', 'v0.1.0', ...(kind === 'checksum' ? ['--bundle-dir', f.assets] : [])], kind === 'http' ? { DOCKER_TEST_DOWNLOAD_FAIL: '1' } : {});
    assert.notEqual(result.status, 0); assert.equal(readFileSync(join(f.target, '.deploy/active'), 'utf8'), 'v0.0.9\n'); assertNoStartup(f);
  }
});
test('archive traversal, control-character names, links and unexpected files are rejected before extraction/startup', () => {
  for (const options of [{ extra: { name: '../escaped', body: 'bad' } }, { extra: { name: 'personalplatform-v0.1.0/README.md\nother', body: 'bad' } }, { link: true }, { extra: { name: 'personalplatform-v0.1.0/private.env', body: 'must-not-install' } }]) {
    const f = fixture(); bundle(f.assets, 'v0.1.0', options); const result = f.run(['--version', 'v0.1.0', '--bundle-dir', f.assets]); assert.notEqual(result.status, 0); assertNoStartup(f); assert.ok(!existsSync(join(f.target, 'releases/v0.1.0')));
  }
});
test('internal tampering is rejected even when the outer archive checksum is valid', () => {
  const f = fixture(); bundle(f.assets, 'v0.1.0', { badInternal: true }); const result = f.run(['--version', 'v0.1.0', '--bundle-dir', f.assets]); assert.notEqual(result.status, 0); assertNoStartup(f); assert.ok(!f.calls().some(call => call.args[0] === 'pull'));
});
test('existing container/volume collisions do not start services and cannot leave a resumable staged bypass', () => {
  for (const collision of ['container', 'volume']) {
    const f = fixture(), env = privateEnv(f); const result = f.run(['--version', 'v0.1.0', '--bundle-dir', f.assets, '--env-file', env], { DOCKER_TEST_COLLISION: collision });
    assert.notEqual(result.status, 0, result.stdout); assert.match(result.stderr, /already|exists/); assertNoStartup(f); assert.ok(!existsSync(join(f.target, '.deploy/pending')));
    const resumed = f.run(['--resume']); assert.notEqual(resumed.status, 0); assert.match(resumed.stderr, /No pending/);
  }
});
test('literal private env is never evaluated, never logged and wins over ambient interpolation variables', () => {
  const f = fixture(); const sentinel = join(f.root, 'executed'); const secret = `$(touch ${sentinel})`; const env = privateEnv(f, secret);
  const result = f.run(['--version', 'v0.1.0', '--bundle-dir', f.assets, '--env-file', env], { DOCKER_TEST_COLLISION: 'volume' });
  assert.notEqual(result.status, 0); assert.match(result.stderr, /already exists/); assert.ok(!existsSync(sentinel)); assert.equal(readFileSync(join(f.target, '.env.release'), 'utf8'), readFileSync(env, 'utf8')); assert.equal(statSync(join(f.target, '.env.release')).mode & 0o777, 0o600);
  assert.ok(!`${result.stdout}${result.stderr}`.includes(secret));
  const configCall = f.calls().find(call => call.args[0] === 'compose' && call.args.includes('config')); assert.equal(configCall.ambientProject, null); assert.equal(configCall.ambientPassword, 'cleared'); assertNoStartup(f);
});
test('unfinished operations require explicit same-target forward retry and never claim unverifiable stopped writers', () => {
  const f = fixture(); mkdirSync(join(f.target, '.deploy/pending'), { recursive: true }); writeFileSync(join(f.target, '.deploy/managed'), '1\n'); writeFileSync(join(f.target, '.deploy/pending/target'), 'v0.1.1\n'); writeFileSync(join(f.target, '.deploy/pending/phase'), 'failed\n'); writeFileSync(join(f.target, '.deploy/pending/backup'), '/retained/private-backup\n');
  const plain = f.run([]); assert.notEqual(plain.status, 0); assert.match(plain.stderr, /unfinished/);
  const different = f.run(['--resume', '--version', 'v0.1.2']); assert.notEqual(different.status, 0); assert.match(different.stderr, /cannot change/); assert.match(different.stderr, /could not be verified/); assert.equal(readFileSync(join(f.target, '.deploy/pending/target'), 'utf8'), 'v0.1.1\n'); assertNoStartup(f);
});

test('lookalike registry names fail before any image is pulled', () => {
  const f = fixture(); bundle(f.assets, 'v0.1.0', { lookalike: true }); const result = f.run(['--version', 'v0.1.0', '--bundle-dir', f.assets]); assert.notEqual(result.status, 0); assert.match(result.stderr, /must pin both official/); assert.ok(!f.calls().some(call => call.args[0] === 'pull'));
});


test('container inspection executes the parser instead of Node debugger mode', () => {
  const f = fixture(), source = readFileSync(script, 'utf8');
  const program = source.match(/read -r -d '' JSON_PROGRAM <<'JS' \|\| true\n([\s\S]*?)\nJS\n/)[1];
  const wrapper = source.match(/^json_action\(\) \{.*\}$/m)[0];
  const action = source.match(/docker inspect \"\$id\" \| json_action (\w+)/)[1];
  const input = [{ Id: 'container-id', Image: 'image-id', Config: { Labels: { 'com.docker.compose.project': 'unit-project', 'com.docker.compose.service': 'backend', 'com.docker.compose.project.config_files': '/managed/docker/docker-compose.release.yml' } }, State: { Running: true, Health: { Status: 'healthy' } }, Mounts: [{ Type: 'volume', Name: 'unit-project_app-storage', Destination: '/workspace/storage' }] }];
  const command = `read -r -d '' JSON_PROGRAM <<'JS' || true\n${program}\nJS\n${wrapper}\nPARSER_IMAGE=fixture\njson_action ${action} unit-project backend unit-project_app-storage /workspace/storage /managed/docker/docker-compose.release.yml`;
  const result = spawnSync(bash, ['-c', command], { env: f.env, input: JSON.stringify(input), encoding: 'utf8', timeout: 5000 });
  assert.equal(result.status, 0, result.stderr); assert.match(result.stdout, /container-id\nimage-id/); assert.ok(!result.stdout.includes('debug>'));
});

test('journal publication is all-or-nothing across process interruption', () => {
  for (const boundary of ['before', 'after']) {
    const f = fixture(), env = privateEnv(f); const args = ['--version', 'v0.1.0', '--bundle-dir', f.assets, '--env-file', env];
    const killed = f.run(args, { DOCKER_TEST_KILL_JOURNAL: boundary }); assert.equal(killed.signal, 'SIGKILL', killed.stderr);
    const pending = join(f.target, '.deploy/pending');
    if (boundary === 'before') {
      assert.equal(existsSync(pending), false);
      const retry = f.run(args, { DOCKER_TEST_COLLISION: 'volume' }); assert.notEqual(retry.status, 0); assert.match(retry.stderr, /already exists/); assert.ok(!retry.stderr.includes('unfinished'));
    } else {
      for (const file of ['target', 'source', 'phase', 'backup', 'target.env', 'target.env.sha256', 'identity']) assert.ok(existsSync(join(pending, file)), file);
      assert.equal(readFileSync(join(pending, 'target'), 'utf8'), 'v0.1.0\n'); assert.match(readFileSync(join(pending, 'target.env'), 'utf8'), /BACKEND_IMAGE=.*@sha256:/);
      const status = f.run(['--status']); assert.equal(status.status, 0); assert.match(status.stdout, /v0.1.0/);
      const retry = f.run(['--resume'], { DOCKER_TEST_COLLISION: 'volume' }); assert.notEqual(retry.status, 0); assert.match(retry.stderr, /already exists/);
    }
    assertNoStartup(f);
  }
});

test('a failed journal cannot stop another deployment when its daemon owner claim differs', () => {
  const f = fixture(), env = privateEnv(f);
  f.run(['--version', 'v0.1.0', '--bundle-dir', f.assets, '--env-file', env], { DOCKER_TEST_KILL_JOURNAL: 'after' });
  writeFileSync(join(f.target, '.deploy/pending/phase'), 'failed\n');
  const result = f.run(['--resume'], { DOCKER_TEST_FOREIGN_OWNER: '1' });
  assert.notEqual(result.status, 0); assert.match(result.stderr, /owned by another deployment/); assertNoStartup(f); assert.equal(readFileSync(join(f.target, '.deploy/pending/phase'), 'utf8'), 'failed\n');
});

test('an empty .deploy directory does not authorize takeover of an unmanaged nonempty target', () => {
  const f = fixture(); mkdirSync(join(f.target, '.deploy'), { recursive: true }); writeFileSync(join(f.target, 'unrelated-user-file'), 'keep');
  const result = f.run(['--version', 'v0.1.0', '--bundle-dir', f.assets]);
  assert.notEqual(result.status, 0); assert.match(result.stderr, /Unrecognized deployment state/); assert.equal(readFileSync(join(f.target, 'unrelated-user-file'), 'utf8'), 'keep'); assert.equal(f.calls().length, 0);
});


test('forward retry refuses changed private project/database settings before image or app mutation', () => {
  for (const key of ['COMPOSE_PROJECT_NAME', 'POSTGRES_PASSWORD']) {
    const f = fixture(), env = privateEnv(f);
    f.run(['--version', 'v0.1.0', '--bundle-dir', f.assets, '--env-file', env], { DOCKER_TEST_KILL_JOURNAL: 'after' });
    const pending = join(f.target, '.deploy/pending'), target = join(pending, 'target.env');
    writeFileSync(join(pending, 'phase'), 'failed\n');
    const originalHash = readFileSync(join(pending, 'target.env.sha256'), 'utf8');
    writeFileSync(target, readFileSync(target, 'utf8').replace(new RegExp(`^${key}=.*$`, 'm'), `${key}=foreign-project`));
    writeFileSync(join(f.root, 'calls'), '');
    const result = f.run(['--resume']);
    assert.notEqual(result.status, 0); assert.match(result.stderr, /Pending private environment changed/); assertNoStartup(f); assert.ok(!f.calls().some(call => call.args[0] === 'pull'));
    assert.equal(readFileSync(join(pending, 'target.env.sha256'), 'utf8'), originalHash);
  }
});

test('forward retry compares its immutable pending identity instead of replacing it', () => {
  const f = fixture(), env = privateEnv(f);
  f.run(['--version', 'v0.1.0', '--bundle-dir', f.assets, '--env-file', env], { DOCKER_TEST_KILL_JOURNAL: 'after' });
  const pending = join(f.target, '.deploy/pending'), identity = join(pending, 'identity');
  writeFileSync(join(pending, 'phase'), 'failed\n');
  const changed = readFileSync(identity, 'utf8').replace(/^unit-project\n/, 'foreign-project\n'); writeFileSync(identity, changed);
  const result = f.run(['--resume']);
  assert.notEqual(result.status, 0); assert.match(result.stderr, /Pending project\/database identity changed/); assertNoStartup(f); assert.equal(readFileSync(identity, 'utf8'), changed);
});


test('forward retry completes a committed active version before pending cleanup, including first install without a prior backup', () => {
  for (const source of ['', 'v0.0.9']) {
    const f = fixture(), env = privateEnv(f), success = { DOCKER_TEST_SUCCESS: '1' };
    const first = f.run(['--version', 'v0.1.0', '--bundle-dir', f.assets, '--env-file', env], { ...success, DOCKER_TEST_KILL_ACTIVE: '1' });
    assert.equal(first.signal, 'SIGKILL', first.stderr);
    const pending = join(f.target, '.deploy/pending');
    assert.equal(readFileSync(join(f.target, '.deploy/active'), 'utf8'), 'v0.1.0\n');
    assert.ok(existsSync(pending));
    if (source) {
      writeFileSync(join(pending, 'source'), `${source}\n`);
      const backup = join(f.target, 'backups', 'accepted-old'); mkdirSync(backup); writeFileSync(join(backup, 'complete'), 'complete\n'); writeFileSync(join(backup, 'database.sql'), '-- prior matching fixture snapshot\n'); writeFileSync(join(backup, 'SHA256SUMS'), `${hash(readFileSync(join(backup, 'database.sql')))}  database.sql\n`); writeFileSync(join(pending, 'backup'), `${backup}\n`);
    }
    for (const accepted of ['.env.release', '.deploy/identity']) {
      const file = join(f.target, accepted), original = readFileSync(file, 'utf8'), callCount = f.calls().length;
      writeFileSync(file, accepted === '.env.release' ? original.replace(/^BACKEND_IMAGE=.*$/m, 'BACKEND_IMAGE=wrong-image') : original.replace(/^unit-project\n/, 'foreign-project\n'));
      const mismatched = f.run(['--resume'], success);
      assert.notEqual(mismatched.status, 0); assert.match(mismatched.stderr, /Accepted target configuration does not match/);
      assert.ok(!f.calls().slice(callCount).some(call => ['up', 'stop', 'start'].some(action => call.args.includes(action))), 'mismatched accepted commit must not mutate application containers');
      writeFileSync(file, original);
    }
    const resumed = f.run(['--resume'], success);
    assert.equal(resumed.status, 0, resumed.stderr); assert.ok(!existsSync(pending)); assert.match(resumed.stdout, /v0.1.0 is healthy/);
    const applied = f.calls().filter(call => call.args[0] === 'compose' && call.args.includes('up')).at(-1).args;
    assert.ok(applied.includes('--force-recreate') && applied.includes('--no-deps')); assert.deepEqual(applied.slice(-2), ['backend', 'frontend']);
  }
});

// Render the actual self-contained launcher without paying for an application
// installation in argument/privilege tests. The saved installer is a recorder.
function launcherFixture(options = {}) {
  const f = fixture(options), source = readFileSync(script, 'utf8');
  const render = source.match(/render_command\(\) \{\n[\s\S]*?\n\}\n(?=cleanup_command_files)/)[0];
  const rendered = spawnSync(bash, ['-c', `DIR=$1; COMMAND_DIR=$2; ${render}\nrender_command`, 'render', f.target, f.commandDir], { encoding: 'utf8', env: f.env });
  assert.equal(rendered.status, 0, rendered.stderr);
  mkdirSync(f.target, { recursive: true }); mkdirSync(f.commandDir, { recursive: true });
  writeFileSync(f.command, rendered.stdout); chmodSync(f.command, 0o755);
  writeFileSync(join(f.target, 'deploy.sh'), '#!/bin/bash\nprintf "%s\\0" "$@" > "$DOCKER_TEST_ROOT/launcher-args"\nif [ "${DOCKER_TEST_COMMAND_SIGNAL:-0}" = 1 ]; then kill -TERM $$; fi\nexit "${DOCKER_TEST_COMMAND_EXIT:-0}"\n');
  const sudo = join(f.root, 'bin/sudo');
  writeFileSync(sudo, `#!${process.execPath}\nrequire('fs').writeFileSync(process.env.DOCKER_TEST_ROOT+'/sudo-args',JSON.stringify(process.argv.slice(2)));process.exit(93);\n`); chmodSync(sudo, 0o755);
  return { ...f, forwarded: () => readFileSync(join(f.root, 'launcher-args'), 'utf8').split('\0').slice(0, -1), owner: uid => writeFileSync(f.command, readFileSync(f.command, 'utf8').replace(/ PP_OWNER_UID=\d+\n/, ` PP_OWNER_UID=${uid}\n`)) };
}

test('launcher binds quoted paths and forwards update/status/resume arguments, status and signals from any cwd', () => {
  const f = launcherFixture({ targetName: 'install "quote" \'single\' $(touch executed)', commandName: 'commands "quote" \'single\' $(touch executed)' });
  const bound = ['--dir', f.target, '--command-dir', f.commandDir];
  const defaultUpdate = spawnSync('/bin/bash', [f.command, 'update'], { encoding: 'utf8', env: f.env, cwd: '/', timeout: 5000 });
  assert.equal(defaultUpdate.status, 0, defaultUpdate.stderr); assert.deepEqual(f.forwarded(), bound);
  const bundleDir = `${f.root}/assets $(touch evaluated) "x" 'y'`;
  const update = f.launch(['update', '--version', 'v1.2.3', '--bundle-dir', bundleDir], { PP_DIRECTORY: '/wrong', PP_COMMAND_DIRECTORY: '/wrong', PP_OWNER_UID: '0', DIR: '/wrong', COMMAND_DIR: '/wrong', DOCKER_TEST_COMMAND_EXIT: '27' }, f.root);
  assert.equal(update.status, 27, update.stderr); assert.deepEqual(f.forwarded(), [...bound, '--version', 'v1.2.3', '--bundle-dir', bundleDir]);
  assert.ok(!existsSync(join(f.root, 'executed')) && !existsSync(join(f.root, 'evaluated')));
  for (const command of ['status', 'resume']) {
    const result = f.launch([command]); assert.equal(result.status, 0, result.stderr); assert.deepEqual(f.forwarded(), [...bound, `--${command}`]);
  }
  const signaled = f.launch(['status'], { DOCKER_TEST_COMMAND_SIGNAL: '1' }); assert.equal(signaled.signal, 'SIGTERM', signaled.stderr);
  assert.ok(!existsSync(join(f.root, 'sudo-args')));
});

test('launcher help is available without its private directory or sudo, including native Bash 3', () => {
  const f = launcherFixture(); f.owner(0);
  renameSync(f.target, `${f.target}.private-unavailable`);
  for (const args of [[], ['help'], ['--help'], ['-h']]) {
    const result = spawnSync('/bin/bash', [f.command, ...args], { encoding: 'utf8', env: f.env, cwd: '/', timeout: 5000 });
    assert.equal(result.status, 0, result.stderr); assert.match(result.stdout, /Usage: pp update/);
  }
  assert.ok(!existsSync(join(f.root, 'sudo-args')) && !existsSync(join(f.root, 'launcher-args')));
});

test('launcher rejects unknown commands, forbidden flags and incomplete values before invoking the manager or sudo', () => {
  const f = launcherFixture(); f.owner(0);
  for (const args of [['unknown'], ['--version', 'v0.1.0'], ['update', '--dir', f.root], ['update', '--command-dir', f.root], ['update', '--adopt'], ['update', '--resume'], ['update', '--status'], ['update', '--env-file', 'secret'], ['update', '--version'], ['update', '--bundle-dir', ''], ['status', '--version', 'v0.1.0'], ['resume', '--dir', f.root], ['help', 'extra']]) {
    const result = f.launch(args); assert.notEqual(result.status, 0, args.join(' ')); assert.match(result.stderr, /Unknown|takes no arguments|Missing/);
  }
  assert.ok(!existsSync(join(f.root, 'sudo-args')) && !existsSync(join(f.root, 'launcher-args')));
});

test('launcher refuses a different non-root owner and uses ordinary sudo only for a root-owned deployment', t => {
  const f = launcherFixture(); const uid = process.getuid();
  f.owner(uid + 1 || 1);
  const mismatch = f.launch(['status']); assert.notEqual(mismatch.status, 0); assert.match(mismatch.stderr, /Run pp as that deployment owner/);
  assert.ok(!existsSync(join(f.root, 'sudo-args')) && !existsSync(join(f.root, 'launcher-args')));
  if (uid === 0) { t.diagnostic('Root-owned sudo routing is exercised by non-root process tests; this test process is already root.'); return; }
  f.owner(0);
  const result = f.launch(['update', '--version', 'v0.1.0']); assert.equal(result.status, 93, result.stderr);
  assert.deepEqual(JSON.parse(readFileSync(join(f.root, 'sudo-args'), 'utf8')), ['--', '/bin/bash', join(f.target, 'deploy.sh'), '--dir', f.target, '--command-dir', f.commandDir, '--version', 'v0.1.0']);
  assert.ok(!existsSync(join(f.root, 'launcher-args')));
});

test('command directory, lock and launcher conflicts fail before downloads or application mutation', () => {
  for (const kind of ['directory-mode', 'directory-link', 'lock-mode', 'lock-link', 'target-directory', 'target-link', 'target-mode', 'target-unrelated', 'target-foreign', 'held-lock']) {
    const f = fixture(); mkdirSync(f.commandDir);
    const retained = join(f.root, 'retained'); writeFileSync(retained, 'do not touch\n');
    if (kind === 'directory-mode') chmodSync(f.commandDir, 0o777);
    if (kind === 'directory-link') { rmSync(f.commandDir, { recursive: true }); symlinkSync(f.root, f.commandDir); }
    if (kind === 'lock-mode') { writeFileSync(join(f.commandDir, '.personalplatform-pp.lock'), 'lock'); chmodSync(join(f.commandDir, '.personalplatform-pp.lock'), 0o666); }
    if (kind === 'lock-link') symlinkSync(retained, join(f.commandDir, '.personalplatform-pp.lock'));
    if (kind === 'target-directory') mkdirSync(f.command);
    if (kind === 'target-link') symlinkSync(retained, f.command);
    if (kind === 'target-mode' || kind === 'target-unrelated') { writeFileSync(f.command, 'unrelated command\n'); chmodSync(f.command, kind === 'target-mode' ? 0o777 : 0o755); }
    if (kind === 'target-foreign') {
      const foreign = launcherFixture(); writeFileSync(f.command, readFileSync(foreign.command)); chmodSync(f.command, 0o755);
    }
    const before = existsSync(f.command) && statSync(f.command).isFile() ? readFileSync(f.command, 'utf8') : null;
    const result = f.run(['--version', 'v0.1.0'], kind === 'held-lock' ? { DOCKER_TEST_COMMAND_LOCK_FAIL: '1' } : {});
    assert.notEqual(result.status, 0, kind); assert.equal(f.calls().length, 0, kind); assert.ok(!existsSync(join(f.root, 'downloads')), kind); assertNoStartup(f);
    assert.equal(readFileSync(retained, 'utf8'), 'do not touch\n');
    if (before !== null) assert.equal(readFileSync(f.command, 'utf8'), before, kind);
    if (kind !== 'directory-link') assert.ok(!readdirSync(f.commandDir).some(name => name.startsWith('.pp.new.')), kind);
  }
});

test('successful installation registers a readable executable and same-version rerun repairs it using the saved command directory', () => {
  const f = fixture({ commandName: 'private bin with spaces' }), env = privateEnv(f), success = { DOCKER_TEST_SUCCESS: '1' };
  const initial = f.run(['--version', 'v0.1.0', '--bundle-dir', f.assets, '--env-file', env], success);
  assert.equal(initial.status, 0, initial.stderr); assert.equal(statSync(f.commandDir).mode & 0o777, 0o755); assert.equal(statSync(f.command).mode & 0o777, 0o755);
  assert.equal(statSync(join(f.target, 'deploy.sh')).mode & 0o777, 0o700);
  assert.equal(readFileSync(join(f.target, '.deploy/command.path'), 'utf8'), `${f.commandDir}\n`);
  assert.equal(readFileSync(join(f.target, '.deploy/command.sha256'), 'utf8'), `${hash(readFileSync(f.command))}\n`);
  const privateBefore = readFileSync(join(f.target, '.env.release'), 'utf8');
  rmSync(f.command);
  const repaired = f.runSaved(['--version', 'v0.1.0', '--bundle-dir', f.assets], success);
  assert.equal(repaired.status, 0, repaired.stderr); assert.match(repaired.stdout, /already active and healthy/); assert.ok(existsSync(f.command));
  assert.equal(readFileSync(join(f.target, '.env.release'), 'utf8'), privateBefore);
  assert.equal(f.calls().filter(call => call.args.includes('up')).length, 1); assert.ok(!f.calls().some(call => call.args.includes('stop')));
  // Preserve an explicitly private existing directory's mode.
  chmodSync(f.commandDir, 0o700);
  const repeated = f.runSaved(['--version', 'v0.1.0', '--bundle-dir', f.assets], success); assert.equal(repeated.status, 0, repeated.stderr); assert.equal(statSync(f.commandDir).mode & 0o777, 0o700);
  const callCount = f.calls().length, changedDirectory = f.run(['--version', 'v0.1.0', '--command-dir', join(f.root, 'different')], success);
  assert.notEqual(changedDirectory.status, 0); assert.match(changedDirectory.stderr, /different command directory/); assert.equal(f.calls().length, callCount);
  writeFileSync(f.command, `${readFileSync(f.command, 'utf8')}# changed by hand\n`);
  const modified = f.runSaved(['--version', 'v0.1.0'], success); assert.notEqual(modified.status, 0); assert.match(modified.stderr, /modified/); assert.equal(f.calls().length, callCount);
});

test('registration conflicts during forward retry cannot trigger the pending deployment recovery trap', () => {
  const f = fixture(), env = privateEnv(f), success = { DOCKER_TEST_SUCCESS: '1' };
  const interrupted = f.run(['--version', 'v0.1.0', '--bundle-dir', f.assets, '--env-file', env], { ...success, DOCKER_TEST_KILL_ACTIVE: '1' });
  assert.equal(interrupted.signal, 'SIGKILL', interrupted.stderr);
  writeFileSync(f.command, 'unrelated executable\n'); chmodSync(f.command, 0o755);
  writeFileSync(join(f.root, 'calls'), '');
  const resumed = f.run(['--resume'], success);
  assert.notEqual(resumed.status, 0); assert.match(resumed.stderr, /Refusing unrelated/); assert.equal(f.calls().length, 0);
  assert.equal(readFileSync(join(f.target, '.deploy/pending/phase'), 'utf8'), 'attempted\n');
});

test('installer-save and launcher-publication failures leave an accepted deployment running and offer the new absolute installer retry', () => {
  for (const failure of ['DOCKER_TEST_FAIL_INSTALLER_SAVE', 'DOCKER_TEST_FAIL_COMMAND_PUBLISH']) {
    const f = fixture(), env = privateEnv(f), success = { DOCKER_TEST_SUCCESS: '1' };
    mkdirSync(join(f.target, '.deploy'), { recursive: true }); writeFileSync(join(f.target, '.deploy/managed'), '1\n');
    writeFileSync(join(f.target, 'deploy.sh'), '#!/bin/bash\necho old-installer-does-not-know-command-dir >&2\nexit 72\n');
    const result = f.run(['--version', 'v0.1.0', '--bundle-dir', f.assets, '--env-file', env], { ...success, [failure]: '1' });
    assert.notEqual(result.status, 0, failure); assert.match(result.stderr, /accepted and healthy/); assert.match(result.stderr, /writers remain running/); assert.ok(result.stderr.includes(`/bin/bash ${script} --dir`), result.stderr);
    assert.equal(readFileSync(join(f.target, '.deploy/active'), 'utf8'), 'v0.1.0\n'); assert.ok(!existsSync(join(f.target, '.deploy/pending')));
    assert.ok(!existsSync(f.command)); assert.ok(!f.calls().some(call => call.args.includes('stop') || call.args.includes('start')));
    assert.ok(!readdirSync(f.commandDir).some(name => name.startsWith('.pp.new.')));
    assert.ok(!readdirSync(join(f.target, '.deploy')).some(name => /^(deploy.new|command.record)\./.test(name)));
    const retried = f.run(['--version', 'v0.1.0', '--bundle-dir', f.assets], success);
    assert.equal(retried.status, 0, retried.stderr); assert.ok(existsSync(f.command)); assert.equal(f.calls().filter(call => call.args.includes('up')).length, 1);
  }
});

test('a newly published exact launcher can be retried when its old private checksum was not updated', () => {
  const f = fixture(), env = privateEnv(f), success = { DOCKER_TEST_SUCCESS: '1' };
  const installed = f.run(['--version', 'v0.1.0', '--bundle-dir', f.assets, '--env-file', env], success); assert.equal(installed.status, 0, installed.stderr);
  const canonical = readFileSync(f.command, 'utf8'), previous = `${canonical}# older managed launcher template\n`, previousHash = `${hash(previous)}\n`;
  writeFileSync(f.command, previous); writeFileSync(join(f.target, '.deploy/command.sha256'), previousHash);
  const failedRecord = f.runSaved(['--version', 'v0.1.0', '--bundle-dir', f.assets], { ...success, DOCKER_TEST_FAIL_COMMAND_RECORD: '1' });
  assert.notEqual(failedRecord.status, 0); assert.match(failedRecord.stderr, /accepted and healthy/); assert.equal(readFileSync(f.command, 'utf8'), canonical);
  assert.equal(readFileSync(join(f.target, '.deploy/command.sha256'), 'utf8'), previousHash); assert.ok(!existsSync(join(f.target, '.deploy/pending')));
  const retried = f.runSaved(['--version', 'v0.1.0', '--bundle-dir', f.assets], success);
  assert.equal(retried.status, 0, retried.stderr); assert.equal(readFileSync(join(f.target, '.deploy/command.sha256'), 'utf8'), `${hash(canonical)}\n`);
  assert.ok(!f.calls().some(call => call.args.includes('stop') || call.args.includes('start')));
});


test('bound deployment and command paths reject writable or foreign-owned ancestors before Docker or downloads', () => {
  for (const binding of ['deployment', 'command']) for (const hazard of ['writable', 'foreign-owner']) {
    const f = fixture(binding === 'deployment' ? { targetName: 'unsafe-parent/install' } : { commandName: 'unsafe-parent/commands' });
    const leaf = binding === 'deployment' ? f.target : f.commandDir, parent = dirname(leaf);
    mkdirSync(leaf, { recursive: true }); chmodSync(leaf, 0o755);
    if (hazard === 'writable') chmodSync(parent, 0o777);
    const result = f.run(['--version', 'v0.1.0'], { DOCKER_TEST_INFO_FAIL: '1', ...(hazard === 'foreign-owner' ? { DOCKER_TEST_COMMAND_PARENT: parent, DOCKER_TEST_COMMAND_PARENT_OWNER: String(process.getuid() + 1000) } : {}) });
    assert.notEqual(result.status, 0); assert.match(result.stderr, /ancestor/, `${binding}/${hazard}: ${result.stderr}`);
    assert.equal(f.calls().length, 0); assert.ok(!existsSync(join(f.root, 'downloads'))); assertNoStartup(f);
  }
});


test('failed command temporary cleanup preserves the deployment failure status and pending recovery behavior', () => {
  const f = fixture(), env = privateEnv(f);
  const result = f.run(['--version', 'v0.1.0', '--bundle-dir', f.assets, '--env-file', env], { DOCKER_TEST_FAIL_COMMAND_CLEANUP: '1' });
  assert.equal(result.status, 91, result.stderr);
  assert.equal(readFileSync(join(f.target, '.deploy/pending/phase'), 'utf8'), 'failed\n');
  assert.match(result.stderr, /Data and recovery artifacts were retained/);
});

test('saved installer directory and symlink targets are refused before Docker or downloads', () => {
  for (const kind of ['directory', 'symlink']) {
    const f = fixture(), saved = join(f.target, 'deploy.sh');
    mkdirSync(join(f.target, '.deploy'), { recursive: true }); writeFileSync(join(f.target, '.deploy/managed'), '1\n');
    const retained = join(f.root, 'retained-installer'); mkdirSync(retained); writeFileSync(join(retained, 'keep'), 'unchanged\n');
    if (kind === 'directory') mkdirSync(saved); else symlinkSync(retained, saved);
    const result = f.run(['--version', 'v0.1.0'], { DOCKER_TEST_INFO_FAIL: '1' });
    assert.notEqual(result.status, 0); assert.match(result.stderr, /installer|symlink/); assert.equal(f.calls().length, 0);
    assert.ok(!existsSync(join(f.root, 'downloads'))); assert.equal(readFileSync(join(retained, 'keep'), 'utf8'), 'unchanged\n');
  }
});
