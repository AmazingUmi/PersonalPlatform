#!/usr/bin/env node
// Real production-image acceptance. Owns only its random Compose project.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { mkdtempSync, readdirSync, existsSync, rmSync, writeFileSync, mkdirSync, copyFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { verificationOptions, verificationCleanupArgs } from "./docker-verification-options.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const options = verificationOptions(process.argv.slice(2), root);
const temporary = mkdtempSync(join(tmpdir(), "pp-docker-verify-"));
// Resolve a release stack in a directory with no source/build context.
if (options.prebuilt && !options.composeFile) {
  mkdirSync(join(temporary, "docker"));
  for (const file of ["docker-compose.release.yml", "docker-compose.runtime.yml"]) {
    copyFileSync(join(root, "docker", file), join(temporary, "docker", file));
  }
}
const composeFile = options.composeFile ?? (options.prebuilt
  ? join(temporary, "docker/docker-compose.release.yml") : join(root, "docker/docker-compose.prod.yml"));
const project = `pp-docker-verify-${process.pid}-${randomBytes(4).toString("hex")}`;
const envFile = join(temporary, "production.env");
const values = {
  COMPOSE_PROJECT_NAME: project,
  POSTGRES_DB: "personal_platform",
  POSTGRES_USER: "personal_platform",
  // Exercise characters that break an unescaped DATABASE_URL.
  POSTGRES_PASSWORD: `${randomBytes(20).toString("hex")}@:/%?#$`,
  BOOTSTRAP_ADMIN_USERNAME: "docker-verify-admin",
  BOOTSTRAP_ADMIN_PASSWORD: randomBytes(24).toString("hex"),
  BIND_IP: "127.0.0.1",
  FRONTEND_PORT: "0",
  SESSION_COOKIE_SECURE: "true",
  TRUST_PROXY: "uniquelocal",
  LOG_LEVEL: "warn",
  DATABASE_POOL_MAX: "4",
  PG_SHARED_BUFFERS: "64MB",
  PG_WORK_MEM: "2MB",
  PG_MAINTENANCE_WORK_MEM: "32MB",
  PG_MAX_CONNECTIONS: "30",
  HEALTHCHECK_INTERVAL: "30s",
  DATABASE_MEMORY_LIMIT: "1G",
  BACKEND_MEMORY_LIMIT: "512M",
  FRONTEND_MEMORY_LIMIT: "256M",
  DATABASE_CPU_LIMIT: "1.0",
  BACKEND_CPU_LIMIT: "1.0",
  FRONTEND_CPU_LIMIT: "0.5",
  ...(options.prebuilt ? { BACKEND_IMAGE: options.backendImage, FRONTEND_IMAGE: options.frontendImage } : {}),
};
const environment = { ...process.env, ...values };
let composeStarted = false;
let cleaned = false;

function saveEnvironment() {
  Object.assign(environment, values);
  writeFileSync(envFile, Object.entries(values).map(([key, value]) => `${key}='${value}'`).join("\n") + "\n", { mode: 0o600 });
}

function run(command, args, { capture = false, allowFailure = false, expectFailure = false } = {}) {
  const result = spawnSync(command, args, {
    cwd: root, env: environment, encoding: "utf8",
    stdio: capture ? "pipe" : "inherit", maxBuffer: 8 * 1024 * 1024,
  });
  if (expectFailure) {
    assert.ifError(result.error);
    assert.ok(result.status !== null && result.status !== 0, `${command} was expected to reject invalid configuration`);
    return `${result.stdout ?? ""}\n${result.stderr ?? ""}`;
  }
  if (!allowFailure && (result.error || result.status !== 0)) {
    // Do not echo env vars or command arguments: they can contain secrets.
    throw new Error(`${command} failed (${result.error?.message ?? `exit ${result.status}`}): ${capture ? result.stderr : "see output above"}`);
  }
  if (allowFailure && (result.error || result.status !== 0)) {
    console.error(`${command} diagnostic/cleanup failed (${result.error?.message ?? `exit ${result.status}`})`);
    process.exitCode = 1;
  }
  return result.stdout?.trim() ?? "";
}

function compose(args, runOptions) {
  if (options.prebuilt && (args[0] === "up" || args[0] === "run")) {
    args = [args[0], ...(args[0] === "up" ? ["--no-build"] : []), "--pull", "never", ...args.slice(1)];
  }
  return run("docker", ["compose", "--project-name", project, "--env-file", envFile,
    "-f", composeFile, ...args], runOptions);
}

function cleanup() {
  if (cleaned) return;
  cleaned = true;
  if (composeStarted) compose(verificationCleanupArgs(options.prebuilt), { allowFailure: true });
  rmSync(temporary, { recursive: true, force: true });
}

for (const [signal, code] of [["SIGINT", 130], ["SIGTERM", 143]]) {
  process.once(signal, () => { cleanup(); process.exit(code); });
}

const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
let base;
async function request(path, { cookie, ...options } = {}) {
  return fetch(`${base}${path}`, {
    ...options, redirect: "manual", signal: AbortSignal.timeout(15_000),
    headers: { ...options.headers, ...(cookie ? { cookie } : {}) },
  });
}

async function json(path, options, expected = 200) {
  const response = await request(path, options);
  assert.equal(response.status, expected, `${path}: HTTP ${response.status}`);
  assert.match(response.headers.get("content-type") ?? "", /application\/json/);
  return response.json();
}

async function login(secure) {
  const response = await request("/api/core/auth/login", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ username: values.BOOTSTRAP_ADMIN_USERNAME, password: values.BOOTSTRAP_ADMIN_PASSWORD }),
  });
  assert.equal(response.status, 200, "real bootstrap login");
  const cookie = response.headers.get("set-cookie") ?? "";
  assert.match(cookie, /^pp_session=/);
  assert.match(cookie, /;\s*HttpOnly/i);
  assert.equal(/;\s*Secure(?:;|$)/i.test(cookie), secure, "effective production cookie Secure flag");
  await response.arrayBuffer();
  return cookie.split(";")[0];
}

async function download(path, cookie, expectedHash) {
  const response = await request(path, { cookie });
  assert.equal(response.status, 200, "attachment download through Nginx");
  assert.equal(hash(Buffer.from(await response.arrayBuffer())), expectedHash, "attachment bytes survive storage/HTTP");
}

try {
  saveEnvironment();
  run("docker", ["info"], { capture: true });
  if (!options.prebuilt) run(process.execPath, ["--test", "scripts/test/docker-config.test.mjs", "scripts/test/docker-verification.test.mjs"]);
  console.log(`Verifying isolated ${options.prebuilt ? "prebuilt" : "source-build"} project ${project}`);
  composeStarted = true;
  if (options.prebuilt) {
    const config = JSON.parse(compose(["config", "--format", "json"], { capture: true }));
    assert.ok(Object.values(config.services).every(service => !service.build), "prebuilt mode must not have a build context");
    if (options.pull) compose(["pull"]);
  } else compose(["build"]);
  const expectedImages = options.prebuilt ? Object.fromEntries(["backend", "frontend"].map(service => {
    const ref = values[`${service.toUpperCase()}_IMAGE`];
    const [image] = JSON.parse(run("docker", ["image", "inspect", ref], { capture: true }));
    const host = run("docker", ["info", "--format", "{{.Architecture}}"], { capture: true });
    const architecture = { aarch64: "arm64", x86_64: "amd64" }[host] ?? host;
    assert.equal(image.Os, "linux");
    assert.equal(image.Architecture, architecture, "release verification uses a native image");
    return [service, image.Id];
  })) : {};
  const invalidPool = compose(["run", "--rm", "--no-deps", "-e", "DATABASE_POOL_MAX=", "backend"], { capture: true, expectFailure: true });
  assert.match(invalidPool, /DATABASE_POOL_MAX must be an integer from 1 to 100/, "startup rejects an explicitly empty pool before attempting database access");
  compose(["up", "-d", "--wait", "--wait-timeout", "180"]);

  const port = compose(["port", "frontend", "8080"], { capture: true });
  assert.match(port, /^127\.0\.0\.1:\d+$/);
  base = `http://${port}`;
  for (const service of ["backend", "frontend"]) {
    const id = compose(["ps", "-q", service], { capture: true });
    const [container] = JSON.parse(run("docker", ["inspect", id], { capture: true }));
    if (options.prebuilt) {
      assert.equal(container.Config.Image, values[`${service.toUpperCase()}_IMAGE`], "requested image ref");
      assert.equal(container.Image, expectedImages[service], "running image is the exact inspected candidate");
    }
    assert.ok(container.Config.User && !["root", "0", "0:0"].includes(container.Config.User), `${service} runs non-root`);
    assert.ok(container.Mounts.every((mount) => mount.Type !== "bind"), `${service} has no host source mounts`);
    const probe = container.Config.Healthcheck.Test;
    assert.equal(probe[0], "CMD");
    assert.equal(probe[1], "wget", `${service} uses the runtime lightweight HTTP probe`);
    compose(["exec", "-T", service, ...probe.slice(1)]);
    if (service === "backend") {
      // Exercise the actual image's client/flags against HTTP failure and a
      // stalled server; a successful TCP connection alone is insufficient.
      compose(["exec", "-T", "backend", "node", "--input-type=module", "-e", `
        import assert from 'node:assert/strict';
        import {createServer} from 'node:http';
        import {spawn} from 'node:child_process';
        const probe=${JSON.stringify(probe.slice(1))};
        const check=url=>new Promise((resolve,reject)=>{
          const p=spawn(probe[0],[...probe.slice(1,-1),url],{stdio:'ignore'});
          p.once('error',reject);p.once('exit',code=>resolve(code));
        });
        let mode='unavailable';
        const server=createServer((req,res)=>{if(mode==='unavailable'){res.writeHead(503);res.end('unavailable');}});
        await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
        const url='http://127.0.0.1:'+server.address().port+'/';
        try {
          assert.notEqual(await check(url),0,'HTTP 503 must fail');
          mode='stalled';
          const watchdog=setTimeout(()=>{console.error('probe timeout was not bounded');process.exit(1);},10000);
          try { assert.notEqual(await check(url),0,'stalled HTTP response must time out'); }
          finally {clearTimeout(watchdog);}
        } finally {server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}
        assert.notEqual(await check(url),0,'closed listener must fail');
      `]);
    }
  }
  compose(["exec", "-T", "backend", "node", "--input-type=module", "-e", `
    import assert from 'node:assert/strict';
    import {existsSync,accessSync,constants} from 'node:fs';
    import {createRequire} from 'node:module';
    const require=createRequire(import.meta.url);
    for(const name of ['tsx','typescript','vite']) assert.throws(()=>require.resolve(name),undefined,name+' must not ship in runtime');
    assert.equal(existsSync('/workspace/backend/src'),false);
    assert.equal(existsSync('/workspace/scripts'),false);
    assert.ok(existsSync('/workspace/backend/dist/main.js'));
    accessSync('/workspace/storage',constants.W_OK);
  `]);

  const page = await request("/");
  assert.equal(page.status, 200);
  const html = await page.text();
  const script = html.match(/<script[^>]+src="([^"]+)"/)?.[1];
  assert.ok(script?.startsWith("/_static/"), "built hashed JavaScript in a namespace outside App routes");
  const asset = await request(script);
  assert.equal(asset.status, 200);
  assert.match(asset.headers.get("content-type") ?? "", /javascript/);
  assert.match(asset.headers.get("cache-control") ?? "", /immutable/);
  await asset.arrayBuffer();
  const deep = await request("/notes/docker-deep-link");
  assert.equal(deep.status, 200);
  assert.equal(await deep.text(), html, "SPA deep link serves the same entry");
  const assetAppDeep = await request("/assets/items/docker-deep-link");
  assert.equal(assetAppDeep.status, 200, "Assets detail is an App route, not a static-file path");
  assert.equal(await assetAppDeep.text(), html);
  const missing = await request("/_static/docker-missing.js");
  assert.equal(missing.status, 404, "missing static asset does not fall back to index");
  await missing.arrayBuffer();
  await json("/api/core/health/ready");
  const notFound = await json("/api/core/docker-not-found", {}, 404);
  assert.equal(notFound.error.code, "not_found");
  await json("/api/core/auth/me", {}, 401);
  await login(true);

  // HTTP local smoke deliberately overrides the production Secure default.
  values.SESSION_COOKIE_SECURE = "false";
  saveEnvironment();
  compose(["up", "-d", "--no-deps", "--force-recreate", "--wait", "--wait-timeout", "180", "backend", "frontend"]);
  base = `http://${compose(["port", "frontend", "8080"], { capture: true })}`;
  const cookie = await login(false);
  const appList = await json("/api/core/apps", { cookie });
  const installed = readdirSync(join(root, "apps"), { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && !/^[_.]/.test(entry.name) && existsSync(join(root, "apps", entry.name, "app.yaml")))
    .map((entry) => entry.name).sort();
  assert.deepEqual(appList.items.map((app) => app.id).sort(), installed);
  assert.ok(appList.items.every((app) => app.status !== "error"), "all installed App migrations/activation succeed");
  const migrationTargets = [["core", join(root, "migrations/core")],
    ...installed.map((id) => [id, join(root, "apps", id, "migrations")])]
    .filter(([, directory]) => existsSync(directory));
  const expectedMigrations = Object.fromEntries(migrationTargets.map(([id, directory]) => [id,
    readdirSync(directory).filter((file) => file.endsWith(".sql")).map((file) => file.slice(0, -4)).sort(),
  ]));
  compose(["exec", "-T", "backend", "sh", "/usr/local/bin/pp-backend-entrypoint", "node", "--input-type=module", "-e", `
    import assert from 'node:assert/strict';
    import pg from 'pg';
    const expected=${JSON.stringify(expectedMigrations)};
    const client=new pg.Client({connectionString:process.env.DATABASE_URL});
    await client.connect();
    try {
      const settings={shared_buffers:'64MB',work_mem:'2MB',maintenance_work_mem:'32MB',max_connections:'30',fsync:'on',synchronous_commit:'on'};
      for(const [name,value] of Object.entries(settings)) {
        const {rows}=await client.query('SHOW '+name);
        assert.equal(rows[0][name],value,name+' effective setting');
      }
      for(const [scope,names] of Object.entries(expected)) {
        assert.match(scope,/^[a-z][a-z0-9_]*$/);
        const {rows}=await client.query('SELECT name FROM "'+scope+'".migrations');
        assert.deepEqual(rows.map(row=>row.name).sort(),names,scope+' migrations are all applied');
      }
    } finally { await client.end(); }
  `]);

  // Forged forwarded addresses must not create separate rate-limit identities.
  for (let index = 0; index < 11; index++) {
    const response = await request("/api/core/auth/login", {
      method: "POST", headers: { "content-type": "application/json", "x-forwarded-for": `198.51.100.${index + 1}` },
      body: JSON.stringify({ username: "docker-rate-probe", password: "incorrect-password" }),
    });
    assert.equal(response.status, index === 10 ? 429 : 401, "untrusted XFF cannot bypass login limiting");
    await response.arrayBuffer();
  }

  const item = await json("/api/apps/assets/items", {
    cookie, method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ name: "docker-persistence-probe" }),
  }, 201);
  const bytes = Buffer.alloc(2 * 1024 * 1024 + 37, 0x5a);
  const form = new FormData();
  form.append("file", new Blob([bytes], { type: "application/octet-stream" }), "docker-smoke.bin");
  const attachment = await json(`/api/apps/assets/items/${item.id}/attachments`, { cookie, method: "POST", body: form }, 201);
  const attachmentPath = `/api/apps/assets/items/${item.id}/attachments/${attachment.id}`;
  await download(attachmentPath, cookie, hash(bytes));

  // Recreate database too: this checks both named volumes and stored sessions.
  compose(["up", "-d", "--force-recreate", "--wait", "--wait-timeout", "180"]);
  base = `http://${compose(["port", "frontend", "8080"], { capture: true })}`;
  const retained = await json(`/api/apps/assets/items/${item.id}`, { cookie });
  assert.equal(retained.name, "docker-persistence-probe");
  await download(attachmentPath, cookie, hash(bytes));
  console.log("PASS: production images, fresh migrations, login/cookies, SPA/API proxy, non-root storage, >1 MiB upload and recreation persistence");
} catch (error) {
  console.error(`FAIL: ${error.message}`);
  if (composeStarted) {
    compose(["ps", "--all"], { allowFailure: true });
    compose(["logs", "--no-color", "--tail", "80"], { allowFailure: true });
  }
  process.exitCode = 1;
} finally {
  cleanup();
}
