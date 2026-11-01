import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';

export const DURATIONS = { idle_before: 60, single_client: 60, five_clients: 60, login: 30, attachment_1MiB: 20, attachment_10MiB: 20, idle_after: 60 };

export async function workload({ base, password, onPhase, onRequest, onPhaseEnd, signal, scale = 1 }) {
  let cookie = '', phaseName = 'setup';
  const phases = [], requests = [];
  const request = async (path, { method = 'GET', body, expected = 200, auth = cookie } = {}) => {
    const headers = auth ? { cookie: auth } : {};
    if (body && !(body instanceof FormData)) { headers['content-type'] = 'application/json'; body = JSON.stringify(body); }
    const start = performance.now();
    const response = await fetch(base + path, { method, body, headers, redirect: 'manual', signal: AbortSignal.any([signal, AbortSignal.timeout(30_000)]) });
    const bytes = Buffer.from(await response.arrayBuffer());
    const record = { phase: phaseName, path, method, status: response.status, expected, ms: performance.now() - start, monotonicMs: performance.now(), bytes: bytes.length };
    requests.push(record); onRequest(record);
    assert.equal(response.status, expected, `${method} ${path}: unexpected HTTP ${response.status}`);
    return { data: response.headers.get('content-type')?.includes('application/json') ? JSON.parse(bytes) : bytes, headers: response.headers };
  };
  const login = async (username = 'bench-admin') => {
    const r = await request('/api/core/auth/login', { method: 'POST', auth: '', body: { username, password } });
    const session = r.headers.get('set-cookie');
    assert.match(session, /^pp_session=/); assert.match(session, /HttpOnly/);
    return session.split(';')[0];
  };
  const phase = async (name, fn) => {
    phaseName = name; onPhase(name);
    const p = { name, startMs: performance.now(), startUtc: new Date().toISOString() };
    p.cycles = await fn(); p.endMs = performance.now(); phases.push(p); await onPhaseEnd(p);
  };
  const loop = async (seconds, concurrency, delay, fn) => {
    const end = performance.now() + seconds * scale * 1000; let cycles = 0;
    await Promise.all(Array.from({ length: concurrency }, (_, worker) => (async () => {
      let index = 0;
      while (performance.now() < end) {
        signal.throwIfAborted(); await fn(worker, index++); cycles++;
        await sleep(delay, undefined, { signal });
      }
    })()));
    return cycles;
  };
  const reads = ['/api/core/apps', '/api/apps/tasks/summary', '/api/apps/assets/summary', '/api/apps/notes/summary', '/api/apps/tasks/tasks?q=bench', '/api/apps/notes/notes?q=bench', '/api/apps/assets/items', '/api/apps/focus/state', '/api/apps/clock/alarms'];
  let assetId, taskId, noteId, apps;
  const hash = bytes => createHash('sha256').update(bytes).digest('hex');
  const upload = async bytes => {
    const form = new FormData(); form.append('file', new Blob([bytes]), 'benchmark.bin');
    return (await request(`/api/apps/assets/items/${assetId}/attachments`, { method: 'POST', body: form, expected: 201 })).data;
  };
  await phase('seed', async () => {
    cookie = await login(); apps = (await request('/api/core/apps')).data.items;
    assert.ok(apps.length > 0 && apps.every(a => a.status === 'enabled'));
    for (let i = 0; i < 500; i++) taskId = (await request('/api/apps/tasks/tasks', { method: 'POST', expected: 201, body: { title: `bench task ${i}`, description: 'benchmark '.repeat(20), priority: i % 4 } })).data.id;
    for (let i = 0; i < 500; i++) noteId = (await request('/api/apps/notes/notes', { method: 'POST', expected: 201, body: { title: `bench note ${i}`, content: 'benchmark '.repeat(100) } })).data.id;
    for (let i = 0; i < 200; i++) assetId = (await request('/api/apps/assets/items', { method: 'POST', expected: 201, body: { name: `bench asset ${i}` } })).data.id;
    const html = (await request('/')).data.toString();
    for (const match of html.matchAll(/(?:src|href)="([^"]+\.(?:js|css))"/g)) await request(match[1]);
  });
  await phase('isolation', async () => {
    await request('/api/core/auth/users', { method: 'POST', expected: 201, body: { username: 'bench-second', password } });
    const bob = await login('bench-second');
    for (const path of ['/api/apps/tasks/tasks', '/api/apps/notes/notes', '/api/apps/assets/items']) assert.equal((await request(path, { auth: bob })).data.items.length, 0);
    for (const path of [`/api/apps/tasks/tasks/${taskId}`, `/api/apps/notes/notes/${noteId}`, `/api/apps/assets/items/${assetId}`]) {
      await request(path, { auth: bob, expected: 404 });
      await request(path, { auth: bob, method: 'DELETE', expected: 404 });
    }
    await request(`/api/apps/tasks/tasks/${taskId}`, { auth: bob, method: 'PATCH', body: { title: 'forbidden' }, expected: 404 });
    const b = (await request('/api/apps/tasks/tasks', { auth: bob, method: 'POST', body: { title: 'second-user-private' }, expected: 201 })).data;
    await request(`/api/apps/tasks/tasks/${b.id}`, { expected: 404 });
    await request(`/api/apps/tasks/tasks/${b.id}`, { auth: bob, method: 'DELETE', expected: 204 });
    const bytes = Buffer.alloc(1024, 0x5a), attachment = await upload(bytes);
    const path = `/api/apps/assets/items/${assetId}/attachments/${attachment.id}`;
    await request(path, { auth: bob, expected: 404 });
    await request(path, { auth: bob, method: 'DELETE', expected: 404 });
    assert.equal(hash((await request(path)).data), hash(bytes));
    await request(path, { method: 'DELETE', expected: 204 });
    await request(`/api/apps/tasks/tasks/${taskId}`); await request(`/api/apps/notes/notes/${noteId}`); await request(`/api/apps/assets/items/${assetId}`);
    await request('/api/core/auth/logout', { auth: bob, method: 'POST', expected: 204 });
    await request('/api/core/auth/me', { auth: bob, expected: 401 });
  });
  const cycle = async (worker, index) => {
    await Promise.all(reads.map(path => request(path)));
    const task = (await request('/api/apps/tasks/tasks', { method: 'POST', expected: 201, body: { title: `bench task ${worker}-${index}`, description: 'benchmark', priority: 2 } })).data;
    await request(`/api/apps/tasks/tasks/${task.id}`, { method: 'PATCH', body: { status: 'done' } });
    await request(`/api/apps/tasks/tasks/${task.id}`, { method: 'DELETE', expected: 204 });
    const note = (await request('/api/apps/notes/notes', { method: 'POST', expected: 201, body: { title: 'bench note', content: 'benchmark '.repeat(100) } })).data;
    await request(`/api/apps/notes/notes/${note.id}`, { method: 'PATCH', body: { pinned: true } });
    await request(`/api/apps/notes/notes/${note.id}`, { method: 'DELETE', expected: 204 });
  };
  await phase('idle_before', () => sleep(DURATIONS.idle_before * scale * 1000, undefined, { signal }));
  await phase('single_client', () => loop(DURATIONS.single_client, 1, 1000, cycle));
  await phase('five_clients', () => loop(DURATIONS.five_clients, 5, 1000, cycle));
  await phase('login', () => loop(DURATIONS.login, 1, 500, async () => { cookie = await login(); }));
  for (const size of [1, 10]) await phase(`attachment_${size}MiB`, async () => {
    const bytes = Buffer.alloc(size * 1024 * 1024, 0x5a);
    return loop(DURATIONS[`attachment_${size}MiB`], 1, 500, async () => {
      const a = await upload(bytes), path = `/api/apps/assets/items/${assetId}/attachments/${a.id}`;
      assert.equal(hash((await request(path)).data), hash(bytes));
      await request(path, { method: 'DELETE', expected: 204 });
    });
  });
  await phase('idle_after', () => sleep(DURATIONS.idle_after * scale * 1000, undefined, { signal }));
  return { phases, requests, apps: apps.map(({ id, status }) => ({ id, status })), isolationPassed: true };
}
