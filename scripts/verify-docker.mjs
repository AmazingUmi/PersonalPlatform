#!/usr/bin/env node
// Real production-image acceptance. Owns only its random Compose project.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { mkdtempSync, readdirSync, existsSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const temporary = mkdtempSync(join(tmpdir(), "pp-docker-verify-"));
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
};
const environment = { ...process.env, ...values };
let composeStarted = false;
let cleaned = false;

function saveEnvironment() {
  Object.assign(environment, values);
  writeFileSync(envFile, Object.entries(values).map(([key, value]) => `${key}='${value}'`).join("\n") + "\n", { mode: 0o600 });
}

function run(command, args, { capture = false, allowFailure = false } = {}) {
  const result = spawnSync(command, args, {
    cwd: root, env: environment, encoding: "utf8",
    stdio: capture ? "pipe" : "inherit", maxBuffer: 8 * 1024 * 1024,
  });
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

function compose(args, options) {
  return run("docker", ["compose", "--project-name", project, "--env-file", envFile,
    "-f", join(root, "docker/docker-compose.prod.yml"), ...args], options);
}

function cleanup() {
  if (cleaned) return;
  cleaned = true;
  if (composeStarted) compose(["down", "--volumes", "--remove-orphans", "--rmi", "local", "--timeout", "20"], { allowFailure: true });
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
  run(process.execPath, ["--test", "scripts/test/docker-config.test.mjs"]);
  console.log(`Building isolated production project ${project}`);
  composeStarted = true;
  compose(["build"]);
  compose(["up", "-d", "--wait", "--wait-timeout", "180"]);

  const port = compose(["port", "frontend", "8080"], { capture: true });
  assert.match(port, /^127\.0\.0\.1:\d+$/);
  base = `http://${port}`;
  for (const service of ["backend", "frontend"]) {
    const id = compose(["ps", "-q", service], { capture: true });
    const [container] = JSON.parse(run("docker", ["inspect", id], { capture: true }));
    assert.ok(container.Config.User && !["root", "0", "0:0"].includes(container.Config.User), `${service} runs non-root`);
    assert.ok(container.Mounts.every((mount) => mount.Type !== "bind"), `${service} has no host source mounts`);
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
