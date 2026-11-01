#!/usr/bin/env node
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import { tmpdir, platform, arch, cpus, totalmem } from 'node:os';
import { dirname, join, resolve, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';
import { memoryCounters, summarize } from './metrics.mjs';
import { DURATIONS, workload } from './workload.mjs';

const ownRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const args = process.argv.slice(2), options = {};
for (let i = 0; i < args.length; i++) {
  if (!['--source', '--output', '--label', '--revision', '--scale'].includes(args[i]) || !args[i + 1]) throw new Error('Usage: node scripts/benchmark-runtime/run.mjs --source DIR --output NEW_DIR --label NAME [--revision SHA] [--scale 0.02]');
  options[args[i].slice(2)] = args[++i];
}
if (!options.output) throw new Error('--output must be a new output directory');
const source = resolve(options.source ?? ownRoot), output = resolve(options.output), scale = Number(options.scale ?? 1);
if (!(scale > 0 && scale <= 10)) throw new Error('--scale must be > 0 and <= 10');
const composeFile = join(source, 'docker/docker-compose.prod.yml');
if (!existsSync(composeFile)) throw new Error('Source must contain docker/docker-compose.prod.yml');
if (existsSync(output)) throw new Error('Refusing to overwrite an existing output directory');
mkdirSync(output, { recursive: true });
const temporary = mkdtempSync(join(tmpdir(), 'pp-runtime-bench-'));
const project = `pp-runtime-bench-${process.pid}-${randomBytes(4).toString('hex')}`;
const envFile = join(temporary, 'production.env');
const values = { COMPOSE_PROJECT_NAME: project, POSTGRES_DB: 'benchmark', POSTGRES_USER: 'benchmark',
  POSTGRES_PASSWORD: randomBytes(24).toString('hex'), BOOTSTRAP_ADMIN_USERNAME: 'bench-admin', BOOTSTRAP_ADMIN_PASSWORD: randomBytes(24).toString('hex'),
  BIND_IP: '127.0.0.1', FRONTEND_PORT: '0', SESSION_COOKIE_SECURE: 'false' };
writeFileSync(envFile, Object.entries(values).map(([k, v]) => `${k}='${v}'`).join('\n') + '\n', { mode: 0o600 });
// Use source defaults, not unrelated shell overrides or a developer's .env.
const environment = { ...process.env };
for (const match of readFileSync(composeFile, 'utf8').matchAll(/\$\{([A-Z][A-Z0-9_]*)/g)) delete environment[match[1]];
Object.assign(environment, values);
const controller = new AbortController();
const activeChildren = new Set();
controller.signal.addEventListener('abort', () => {
  // Cancel a pending build/up/exec before the finally block removes owned resources.
  for (const child of activeChildren) child.kill('SIGTERM');
});
let started = false, sampling = false, sampler, phaseName = 'startup', socketPath;
let ids = {}, samples = [], phases = [], requests = [], metadata = {}, passed = false;
const write = (name, value) => writeFileSync(join(output, name), JSON.stringify(value, null, 2) + '\n');
for (const name of ['SIGINT', 'SIGTERM']) process.once(name, () => controller.abort(new Error(`Interrupted by ${name}`)));

async function run(command, argv, { allowFailure = false, record = false, cwd = source } = {}) {
  const child = spawn(command, argv, { cwd, env: environment, stdio: ['ignore', 'pipe', 'pipe'] });
  activeChildren.add(child);
  let stdout = '', stderr = '';
  child.stdout.on('data', data => { stdout += data; if (record) appendFileSync(join(output, 'operations.log'), data); });
  child.stderr.on('data', data => { stderr += data; if (record) appendFileSync(join(output, 'operations.log'), data); });
  const code = await new Promise((resolveExit, reject) => {
    child.on('error', error => { activeChildren.delete(child); reject(error); });
    child.on('close', status => { activeChildren.delete(child); resolveExit(status); });
  });
  if (code !== 0 && !allowFailure) throw new Error(`${command} exited ${code}: ${stderr.slice(-2000)}`);
  return { code, stdout: stdout.trim(), stderr };
}
const compose = (argv, opts) => run('docker', ['compose', '--project-name', project, '--env-file', envFile, '-f', composeFile, ...argv], opts);
const psql = async sql => (await compose(['exec', '-T', 'database', 'psql', '-U', 'benchmark', '-d', 'benchmark', '-At', '-c', sql])).stdout;
function getStats(id) {
  return new Promise((resolveStats, reject) => {
    const req = http.get({ socketPath, path: `/containers/${id}/stats?stream=false&one-shot=true`, timeout: 5000 }, response => {
      let body = ''; response.on('data', data => { body += data; });
      response.on('end', () => { try { if (response.statusCode !== 200) throw new Error(`Docker stats HTTP ${response.statusCode}`); resolveStats(JSON.parse(body)); } catch (error) { reject(error); } });
      response.on('error', reject);
    });
    req.on('timeout', () => req.destroy(new Error('Docker stats timeout'))); req.on('error', reject);
  });
}
async function sample() {
  const name = phaseName;
  const data = await Promise.all(Object.entries(ids).map(async ([service, id]) => {
    const raw = await getStats(id);
    const cpuNanoseconds = raw.cpu_stats?.cpu_usage?.total_usage;
    if (!Number.isFinite(cpuNanoseconds)) throw new Error('Docker CPU counter missing');
    return [service, { id, cpuNanoseconds, memory: memoryCounters(raw), raw }];
  }));
  if (name !== phaseName) return;
  const entry = { time: new Date().toISOString(), monotonicMs: performance.now(), phase: name, services: Object.fromEntries(data) };
  samples.push(entry); appendFileSync(join(output, 'samples.jsonl'), JSON.stringify(entry) + '\n');
}
async function sampleLoop() {
  while (sampling && !controller.signal.aborted) {
    const start = performance.now();
    await sample();
    await sleep(Math.max(0, 1000 - (performance.now() - start)));
  }
}
async function containers() {
  return JSON.parse((await run('docker', ['inspect', ...Object.values(ids)])).stdout).map(c => ({
    id: c.Id, name: c.Name, imageId: c.Image, status: c.State.Status, health: c.State.Health?.Status,
    oomKilled: c.State.OOMKilled, restartCount: c.RestartCount, memoryLimit: c.HostConfig.Memory, nanoCpus: c.HostConfig.NanoCpus,
  }));
}
function sanitize(value) {
  if (Array.isArray(value)) return value.map(sanitize);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, /PASSWORD|SECRET|TOKEN|DATABASE_URL/i.test(k) ? '[REDACTED]' : sanitize(v)]));
}
async function sourceManifest() {
  const listed = await run('git', ['ls-files', '--cached', '--others', '--exclude-standard', '-z'], { allowFailure: true });
  let files;
  if (!listed.code) files = listed.stdout.split('\0').filter(Boolean);
  else {
    const walk = dir => readdirSync(dir, { withFileTypes: true }).flatMap(e => {
      if (['.git', 'node_modules', 'dist', 'storage', 'backups', '.env', '.env.production'].includes(e.name)) return [];
      const path = join(dir, e.name); return e.isDirectory() ? walk(path) : [relative(source, path)];
    });
    files = walk(source);
  }
  const hash = createHash('sha256');
  const manifest = files.sort().filter(p => !/(^|\/)\.env(?:\.|$)/.test(p) || p.endsWith('.example')).map(path => {
    const sha256 = createHash('sha256').update(readFileSync(join(source, path))).digest('hex');
    hash.update(path + '\0' + sha256 + '\n'); return { path, sha256 };
  });
  write('source-manifest.json', manifest); return hash.digest('hex');
}
try {
  const context = JSON.parse((await run('docker', ['context', 'inspect'])).stdout)[0];
  const endpoint = process.env.DOCKER_HOST ?? context.Endpoints.docker.Host;
  if (!endpoint.startsWith('unix://')) throw new Error('Benchmark stats currently require a local Unix-socket Docker context');
  socketPath = endpoint.slice(7);
  const revision = await run('git', ['rev-parse', 'HEAD'], { allowFailure: true });
  const dockerInfo = JSON.parse((await run('docker', ['info', '--format', '{{json .}}'])).stdout);
  metadata = { label: options.label ?? project, project, source, sourceRevision: options.revision ?? (revision.code ? null : revision.stdout),
    sourceManifestSha256: await sourceManifest(), host: { platform: platform(), arch: arch(), cpus: cpus().length, totalMemoryBytes: totalmem() },
    scale, formalDurationsSeconds: DURATIONS, dataset: { tasks: 500, notes: 500, assets: 200, accounts: 2 },
    engine: Object.fromEntries(['ServerVersion', 'OSType', 'Architecture', 'NCPU', 'MemTotal', 'CgroupVersion'].map(key => [key, dockerInfo[key]])),
    startedUtc: new Date().toISOString(), metrics: { cpu: 'cgroup cumulative CPU delta / monotonic wall time; 100%=one logical core',
      memory: 'raw usage and Docker working set = usage - inactive_file (cgroup v2) or total_inactive_file (v1); host/client excluded' } };
  metadata.harnessSha256 = createHash('sha256').update(['run.mjs', 'workload.mjs', 'metrics.mjs'].map(name => readFileSync(join(dirname(fileURLToPath(import.meta.url)), name))).reduce((a, b) => Buffer.concat([a, b]), Buffer.alloc(0))).digest('hex');
  const resolved = JSON.parse((await compose(['config', '--format', 'json'])).stdout);
  write('compose-resolved.json', sanitize(resolved));
  console.log(`BUILD ${metadata.label} ${project}`);
  controller.signal.throwIfAborted();
  started = true; await compose(['build'], { record: true });
  controller.signal.throwIfAborted();
  const startup = performance.now();
  await compose(['up', '-d', '--wait', '--wait-timeout', '180'], { record: true });
  metadata.startupSeconds = (performance.now() - startup) / 1000;
  for (const service of ['database', 'backend', 'frontend']) ids[service] = (await compose(['ps', '-q', service])).stdout;
  assert.ok(Object.values(ids).every(id => /^[a-f0-9]+$/.test(id)));
  metadata.containers = await containers();
  metadata.baseImages = JSON.parse((await run('docker', ['image', 'inspect', 'node:22-alpine', 'postgres:17-alpine', 'nginxinc/nginx-unprivileged:stable-alpine'])).stdout).map(image => ({ id: image.Id, repoDigests: image.RepoDigests, architecture: image.Architecture }));
  assert.ok(metadata.containers.every(c => c.health === 'healthy' && !c.oomKilled && c.restartCount === 0));
  metadata.versions = {
    node: (await compose(['exec', '-T', 'backend', 'node', '--version'])).stdout,
    postgres: (await psql('SHOW server_version')),
    nginx: (await compose(['exec', '-T', 'frontend', 'nginx', '-v'])).stderr.trim(),
  };
  metadata.pgSettings = JSON.parse(await psql("SELECT json_agg(row_to_json(s)) FROM (SELECT name,setting,unit FROM pg_settings WHERE name IN ('shared_buffers','work_mem','maintenance_work_mem','max_connections','fsync','synchronous_commit')) s"));
  const address = (await compose(['port', 'frontend', '8080'])).stdout;
  assert.match(address, /^127\.0\.0\.1:\d+$/); metadata.baseUrl = `http://${address}`;
  write('metadata.json', metadata);
  sampling = true;
  sampler = sampleLoop().catch(error => { controller.abort(error); throw error; });
  // Attach a handler immediately so sampler errors cannot become unhandled rejections.
  sampler.catch(() => {});
  const connections = [];
  const result = await workload({ base: metadata.baseUrl, password: values.BOOTSTRAP_ADMIN_PASSWORD, signal: controller.signal, scale,
    onPhase(name) { phaseName = name; console.log(`PHASE ${metadata.label} ${name}`); },
    onRequest(record) { requests.push(record); appendFileSync(join(output, 'requests.jsonl'), JSON.stringify(record) + '\n'); },
    async onPhaseEnd(p) {
      phaseName = 'between'; phases.push(p); write('phases.json', phases);
      connections.push({ phase: p.name, postgresConnections: Number(await psql("SELECT count(*) FROM pg_stat_activity WHERE datname=current_database() AND pid<>pg_backend_pid()")) });
      write('connections.json', connections);
    },
  });
  sampling = false; await sampler;
  metadata.apps = result.apps; metadata.isolationPassed = result.isolationPassed;
  metadata.finalRowCounts = JSON.parse(await psql("SELECT json_build_object('tasks',(SELECT count(*) FROM tasks.tasks),'notes',(SELECT count(*) FROM notes.notes),'assets',(SELECT count(*) FROM assets.items),'attachments',(SELECT count(*) FROM assets.attachments))"));
  assert.deepEqual(metadata.finalRowCounts, { tasks: 500, notes: 500, assets: 200, attachments: 0 });
  metadata.databaseBytes = Number(await psql('SELECT pg_database_size(current_database())'));
  // Read-only diagnostics after sampling stops: retain evidence for latency
  // outliers without changing PostgreSQL settings or measured workload.
  write('postgres-diagnostics.json', {
    checkpointer: JSON.parse(await psql('SELECT row_to_json(s) FROM pg_stat_checkpointer s')),
    wal: JSON.parse(await psql('SELECT row_to_json(s) FROM pg_stat_wal s')),
    settings: JSON.parse(await psql("SELECT json_agg(row_to_json(s)) FROM (SELECT name,setting,unit FROM pg_settings WHERE name IN ('track_io_timing','track_wal_io_timing','checkpoint_timeout','log_checkpoints')) s")),
  });
  metadata.finalContainers = await containers();
  assert.ok(metadata.finalContainers.every(c => c.health === 'healthy' && !c.oomKilled && c.restartCount === 0));
  const summary = summarize(samples, phases, requests);
  if (scale === 1) for (const name of Object.keys(DURATIONS)) {
    assert.ok(summary[name].sampleIntervals >= 3 && summary[name].measuredSeconds >= summary[name].durationSeconds * .8, `${name}: insufficient resource sample coverage`);
  }
  write('metadata.json', metadata); write('summary.json', summary);
  passed = true; console.log(`PASS ${metadata.label}: ${requests.length} expected responses, hashes and two-account isolation`);
} catch (error) {
  controller.abort(error);
  process.exitCode = 1; console.error(`FAIL ${error.message}`); write('failure.json', { message: error.message });
} finally {
  sampling = false;
  if (sampler) await sampler.catch(() => {});
  if (samples.length) {
    try { write('summary.json', summarize(samples, phases, requests)); }
    catch (error) { process.exitCode = 1; console.error(`SUMMARY FAIL: ${error.message}`); }
  }
  const cleanup = { workloadPassed: passed, project, containersRemoved: false, volumesRemoved: false, imagesRemoved: false };
  try {
    if (started) {
      // Collect logs before removing containers; a diagnostics failure must not
      // bypass cleanup. Test credentials/bodies are not logged by the platform.
      for (const service of ['database', 'backend', 'frontend']) {
        try {
          const result = await compose(['logs', '--no-color', '--timestamps', service], { allowFailure: true });
          writeFileSync(join(output, `${service}.log`), result.stdout + '\n' + result.stderr);
          if (result.code) process.exitCode = 1;
        } catch (error) { process.exitCode = 1; console.error(`LOG CAPTURE FAIL: ${error.message}`); }
      }
      const result = await compose(['down', '--volumes', '--remove-orphans', '--rmi', 'local', '--timeout', '20'], { allowFailure: true, record: true });
      const remaining = await Promise.all([
        run('docker', ['ps', '-aq', '--filter', `label=com.docker.compose.project=${project}`], { allowFailure: true }),
        run('docker', ['volume', 'ls', '-q', '--filter', `label=com.docker.compose.project=${project}`], { allowFailure: true }),
        run('docker', ['images', '-q', '--filter', `reference=${project}-*`], { allowFailure: true }),
      ]);
      [cleanup.containersRemoved, cleanup.volumesRemoved, cleanup.imagesRemoved] = remaining.map(result => result.code === 0 && !result.stdout);
      if (result.code || remaining.some(result => result.code || result.stdout)) process.exitCode = 1;
    }
  } catch (error) {
    process.exitCode = 1; cleanup.error = error.message;
  } finally {
    rmSync(temporary, { recursive: true, force: true }); cleanup.credentialsRemoved = !existsSync(temporary);
    write('cleanup.json', cleanup); console.log(`CLEANUP ${project} ${JSON.stringify(cleanup)}`);
  }
}
