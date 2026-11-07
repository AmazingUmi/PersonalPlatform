#!/usr/bin/env node
// Real Linux installer acceptance. Owns only random test projects and files.
// The newer release numbers below are controlled lifecycle fixtures using
// the public v0.1.0 application digests, not published application upgrades.
import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import { appendFileSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createBundle, verifyBundle } from "./release-images.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const temporary = mkdtempSync(join(tmpdir(), "pp-deploy-verify-"));
const project = `pp-deploy-verify-${process.pid}-${randomBytes(4).toString("hex")}`;
const projects = [project, `${project}-adopt`];
const helperImage = `${project}-helper`;
const helperName = `${project}-helper-run`;
let installDir = join(temporary, "installed-a");
const helperNames = new Set([helperName]);
const logFile = join(temporary, "commands.log");
const helperHome = join(temporary, "helper-home");
mkdirSync(join(helperHome, ".docker"), { recursive: true, mode: 0o700 });
writeFileSync(join(helperHome, ".docker/config.json"), "{}\n", { mode: 0o600 });
const password = `${randomBytes(20).toString("hex")}@:/%?#$'"\\`;
const databasePassword = `${randomBytes(20).toString("hex")}@:/%?#$'"\\`;
const username = "deploy-verify-admin";
const hash = value => createHash("sha256").update(value).digest("hex");
const redact = value => [password, databasePassword].reduce((text, secret) =>
  text.replaceAll(secret, "[redacted]").replaceAll(JSON.stringify(secret).slice(1, -1), "[redacted]"), String(value));
const frozenInstaller = join(temporary, "deploy-under-test.sh");
const installerBytes = readFileSync(join(root, "scripts/deploy.sh"));
const installerSha256 = hash(installerBytes);
writeFileSync(frozenInstaller, installerBytes, { mode: 0o600 });
let socket;
let builtHelper = false;
let cleaned = false;

function command(binary, args, { input, failure = false, env = process.env } = {}) {
  const result = spawnSync(binary, args, { cwd: root, env, input, encoding: "utf8", maxBuffer: 32 * 1024 * 1024 });
  appendFileSync(logFile, redact(`\n$ ${binary} ${args.join(" ")}\n${result.stdout ?? ""}${result.stderr ?? ""}`), { mode: 0o600 });
  if (result.error || (result.status !== 0 && !failure)) {
    throw new Error(`${binary} failed (${result.error?.message ?? result.status}); details: ${logFile}`);
  }
  return { status: result.status, stdout: result.stdout?.trim() ?? "", stderr: result.stderr?.trim() ?? "" };
}
const docker = (args, options) => command("docker", args, options);
const commandDirectory = directory => join(temporary, "commands", basename(directory));
const commandPath = directory => join(commandDirectory(directory), "pp");

function helperArgs(args, { shim = false, shimDirectory, name = helperName, entry = frozenInstaller } = {}) {
  // Each isolated deployment has its own persistent command directory. Never
  // install into the host or ephemeral helper container's /usr/local/bin.
  if (entry === frozenInstaller && args.includes("--dir") && !args.includes("--command-dir")) {
    args = [...args, "--command-dir", commandDirectory(args[args.indexOf("--dir") + 1])];
  }
  helperNames.add(name);
  const run = ["run", "--rm", "--name", name, "--network", "host",
    "--user", `${process.getuid()}:${process.getgid()}`, "--group-add", String(statSync(socket).gid), "--group-add", "0",
    "--mount", `type=bind,source=${socket},target=/var/run/docker.sock`,
    "--mount", `type=bind,source=${root},target=/workspace,readonly`,
    "--mount", `type=bind,source=${temporary},target=${temporary}`,
    "-e", "DOCKER_HOST=unix:///var/run/docker.sock",
    "-e", `HOME=${helperHome}`, "-e", `DOCKER_CONFIG=${join(helperHome, ".docker")}`,
    // Saved deployment values must win over conflicting ambient settings.
    "-e", "COMPOSE_PROJECT_NAME=unrelated-ambient-project",
    "-e", "POSTGRES_PASSWORD=unrelated-ambient-password",
    "-e", "BACKEND_IMAGE=unrelated/ambient:never",
    "-e", "FRONTEND_PORT=1"];
  const override = shimDirectory ?? (shim ? join(temporary, "shim") : undefined);
  if (override) run.push("-e", `PATH=${override}:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin`);
  run.push(helperImage, entry, ...args);
  return run;
}
function checkHelperOutput(result) {
  const output = `${result.stdout}\n${result.stderr}`;
  for (const secret of [password, databasePassword]) {
    assert.ok(!output.includes(secret) && !output.includes(JSON.stringify(secret).slice(1, -1)), "installer must not print deployment credentials");
  }
  return result;
}
function helper(args, options = {}) {
  const run = helperArgs(args, options);
  const { failure = false } = options;
  const result = docker(run, { failure });
  return checkHelperOutput(result);
}
function asynchronousHelper(args, options) {
  const run = helperArgs(args, options);
  const child = spawn("docker", run, { cwd: root, env: process.env, stdio: ["ignore", "pipe", "pipe"] });
  let stdout = "", stderr = "";
  child.stdout.on("data", data => { stdout += data; });
  child.stderr.on("data", data => { stderr += data; });
  const completion = new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", status => {
      appendFileSync(logFile, redact(`\n$ docker ${run.join(" ")}\n${stdout}${stderr}`), { mode: 0o600 });
      resolve(checkHelperOutput({ status, stdout, stderr }));
    });
  });
  return { child, completion };
}

function inspectService(owner, service) {
  const ids = docker(["ps", "-aq", "--filter", `label=com.docker.compose.project=${owner}`, "--filter", `label=com.docker.compose.service=${service}`]).stdout.split(/\s+/).filter(Boolean);
  assert.equal(ids.length, 1, `${owner}/${service}: one service container`);
  return JSON.parse(docker(["inspect", ids[0]]).stdout)[0];
}

function baseUrl(owner) {
  const container = inspectService(owner, "frontend");
  const [port] = container.NetworkSettings.Ports["8080/tcp"];
  assert.equal(port.HostIp, "127.0.0.1");
  return `http://127.0.0.1:${port.HostPort}`;
}

async function request(base, path, { cookie, ...options } = {}) {
  return fetch(`${base}${path}`, { ...options, signal: AbortSignal.timeout(20_000), headers: { ...options.headers, ...(cookie ? { cookie } : {}) } });
}
async function json(base, path, options, status = 200) {
  const response = await request(base, path, options);
  assert.equal(response.status, status, `${path}: expected HTTP ${status}`);
  return response.json();
}
async function login(base) {
  const response = await request(base, "/api/core/auth/login", {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ username, password }),
  });
  assert.equal(response.status, 200, "administrator login with original credentials");
  return response.headers.get("set-cookie").split(";")[0];
}
async function waitHealthy(owner) {
  for (let attempt = 0; attempt < 60; attempt++) {
    try {
      const response = await request(baseUrl(owner), "/api/core/health/ready");
      if (response.status === 200 && ["backend", "frontend"].every(service => inspectService(owner, service).State.Health?.Status === "healthy")) return;
    } catch { /* startup can briefly refuse connections */ }
    await new Promise(resolve => setTimeout(resolve, 500));
  }
  throw new Error(`${owner}: application did not become healthy after restart`);
}

function envFile(path, owner, template) {
  const values = {
    COMPOSE_PROJECT_NAME: owner, POSTGRES_PASSWORD: JSON.stringify(databasePassword),
    BOOTSTRAP_ADMIN_USERNAME: username, BOOTSTRAP_ADMIN_PASSWORD: JSON.stringify(password),
    BIND_IP: "127.0.0.1", FRONTEND_PORT: "0", SESSION_COOKIE_SECURE: "false",
    // A cold initdb can need >15 seconds before the final TCP listener starts.
    // At 1s, the published 5s start period + 10 failures can expire too early.
    // 5s keeps tests faster than production's 30s without truncating initdb.
    HEALTHCHECK_INTERVAL: "5s", LOG_LEVEL: "warn",
    DATA_BACKUP_ALLOWED_ORIGINS: "https://dav.example.invalid", DATA_BACKUP_ENCRYPTION_KEY: "",
  };
  let content = template;
  for (const [key, value] of Object.entries(values)) {
    assert.match(content, new RegExp(`^${key}=.*$`, "m"));
    content = content.replace(new RegExp(`^${key}=.*$`, "m"), () => `${key}=${value}`);
  }
  content += "\nDEPLOY_PRESERVATION_PROBE='keep this custom value'\n";
  writeFileSync(path, content, { mode: 0o600 });
}

async function getAsset(url, output) {
  const response = await fetch(url, { signal: AbortSignal.timeout(90_000) });
  assert.equal(response.status, 200, "published release asset download");
  writeFileSync(output, Buffer.from(await response.arrayBuffer()), { mode: 0o600 });
}

function cleanProject(owner) {
  assert.ok(projects.includes(owner));
  const containers = docker(["ps", "-aq", "--filter", `label=com.docker.compose.project=${owner}`], { failure: true }).stdout.split(/\s+/).filter(Boolean);
  if (containers.length) docker(["rm", "-f", ...containers], { failure: true });
  for (const type of ["volume", "network"]) {
    const names = docker([type, "ls", "-q", "--filter", `label=com.docker.compose.project=${owner}`], { failure: true }).stdout.split(/\s+/).filter(Boolean);
    if (names.length) docker([type, "rm", ...names], { failure: true });
  }
  const claimName = `${owner}_deploy-owner`;
  const claim = docker(["volume", "inspect", claimName], { failure: true });
  if (claim.status === 0) {
    const [volume] = JSON.parse(claim.stdout);
    assert.equal(volume.Labels?.["io.personalplatform.deploy.managed"], "1");
    assert.equal(volume.Labels?.["io.personalplatform.deploy.project"], owner);
    const ownedDirectory = ["installed-a", "installed-b", "manual"].map(name => join(temporary, name)).find(directory =>
      volume.Labels["io.personalplatform.deploy.directory"] === hash(directory) &&
      existsSync(join(directory, ".deploy/owner")) &&
      readFileSync(join(directory, ".deploy/owner"), "utf8").trim() === volume.Labels["io.personalplatform.deploy.owner"]);
    assert.ok(ownedDirectory, "refusing to remove an ownership claim not created by this acceptance run");
    docker(["volume", "rm", claimName], { failure: true });
  }
}
function cleanup() {
  if (cleaned) return;
  cleaned = true;
  for (const name of helperNames) docker(["rm", "-f", name], { failure: true });
  for (const owner of projects) cleanProject(owner);
  if (builtHelper) docker(["image", "rm", helperImage], { failure: true });
}
for (const [signal, code] of [["SIGINT", 130], ["SIGTERM", 143]]) process.once(signal, () => { cleanup(); process.exit(code); });

function backupDirectories() {
  return readdirSync(join(installDir, "backups"), { withFileTypes: true }).filter(entry => entry.isDirectory()).map(entry => join(installDir, "backups", entry.name));
}

try {
  docker(["info"]);
  const endpoint = process.env.DOCKER_HOST ?? docker(["context", "inspect", "--format", "{{.Endpoints.docker.Host}}"] ).stdout;
  assert.ok(endpoint.startsWith("unix://"), "local acceptance requires a Unix Docker socket");
  socket = endpoint.slice("unix://".length);
  builtHelper = true;
  docker(["build", "-f", "scripts/test/fixtures/deploy-runtime.Dockerfile", "-t", helperImage, "."]);
  helper([`set -e; for binary in node npm python3 jq; do if command -v "$binary" >/dev/null; then echo "Unexpected host runtime: $binary" >&2; exit 1; fi; done; bash -n '${frozenInstaller}'; shellcheck --severity=warning '${frozenInstaller}'; docker compose version --short`], { entry: "-c" });
  const official = join(temporary, "official");
  mkdirSync(official);
  await Promise.all([
    getAsset("https://github.com/AmazingUmi/PersonalPlatform/releases/download/v0.1.0/personalplatform-v0.1.0.tar.gz", join(official, "personalplatform-v0.1.0.tar.gz")),
    getAsset("https://github.com/AmazingUmi/PersonalPlatform/releases/download/v0.1.0/SHA256SUMS", join(official, "SHA256SUMS")),
  ]);
  const checksum = readFileSync(join(official, "SHA256SUMS"), "utf8").match(/^([a-f0-9]{64})  personalplatform-v0\.1\.0\.tar\.gz\s*$/);
  assert.ok(checksum);
  assert.equal(hash(readFileSync(join(official, "personalplatform-v0.1.0.tar.gz"))), checksum[1]);
  command("tar", ["-xzf", join(official, "personalplatform-v0.1.0.tar.gz"), "-C", official]);
  const officialBundle = join(official, "personalplatform-v0.1.0");
  verifyBundle(officialBundle);
  const metadata = JSON.parse(readFileSync(join(officialBundle, "release.json"), "utf8"));
  const template = readFileSync(join(officialBundle, ".env.release.example"), "utf8");
  const fixtureSource = join(temporary, "fixture-source");
  mkdirSync(join(fixtureSource, "docker"), { recursive: true });
  mkdirSync(join(fixtureSource, "scripts"));
  for (const file of ["docker-compose.release.yml", "docker-compose.runtime.yml", "RELEASE_README.md"]) copyFileSync(join(root, "docker", file), join(fixtureSource, "docker", file));
  copyFileSync(join(root, ".env.release.example"), join(fixtureSource, ".env.release.example"));
  copyFileSync(frozenInstaller, join(fixtureSource, "scripts/deploy.sh"));
  const fixtureDirs = {};
  for (const version of ["v0.1.1", "v0.1.2"]) {
    const destination = join(temporary, version);
    const fixture = structuredClone(metadata);
    fixture.version = version;
    for (const service of ["backend", "frontend"]) fixture.images[service].versionReference = `ghcr.io/amazingumi/personalplatform-${service}:${version}`;
    createBundle(fixtureSource, destination, fixture);
    // Production bundles are built on Linux. Repack local macOS fixtures with
    // Linux tar as well, excluding AppleDouble/resource-fork metadata.
    const archive = `personalplatform-${version}.tar.gz`;
    helper([`tar --format=ustar --no-xattrs -czf '${join(destination, archive)}' -C '${destination}' 'personalplatform-${version}'`], { entry: "-c" });
    writeFileSync(join(destination, "SHA256SUMS"), `${hash(readFileSync(join(destination, archive)))}  ${archive}\n`, { mode: 0o600 });
    fixtureDirs[version] = destination;
  }

  const initialEnv = join(temporary, "initial.env");
  envFile(initialEnv, project, template);
  console.log("Racing two fresh directories for one project while installing public v0.1.0");
  const installDirs = [installDir, join(temporary, "installed-b")];
  const race = join(temporary, "race");
  mkdirSync(race);
  const raced = installDirs.map((directory, index) => {
    const shimDirectory = join(race, `bin-${index}`);
    mkdirSync(shimDirectory);
    writeFileSync(join(shimDirectory, "docker"), `#!/usr/bin/env bash\nif [[ $1 == volume && $2 == create && " $* " == *" ${project}_deploy-owner "* ]]; then\n  touch '${race}/${index}.ready'\n  for ((attempt=0;attempt<300;attempt++)); do [[ -f '${race}/${1 - index}.ready' ]] && break; sleep 0.1; done\n  [[ -f '${race}/${1 - index}.ready' ]] || exit 96\nfi\nexec /usr/local/bin/docker "$@"\n`, { mode: 0o755 });
    return asynchronousHelper(["--dir", directory, "--version", "v0.1.0", "--env-file", initialEnv], { name: `${helperName}-${index}`, shimDirectory });
  });
  const raceResults = await Promise.all(raced.map(run => run.completion));
  assert.ok(raceResults.every(result => result.status !== 96), "both installs reached the barrier before its timeout");
  assert.equal(raceResults.filter(result => result.status === 0).length, 1, "exactly one directory must acquire the project ownership claim");
  for (const index of [0, 1]) assert.ok(existsSync(join(race, `${index}.ready`)), "both installs reached ownership creation concurrently");
  const winner = raceResults.findIndex(result => result.status === 0);
  installDir = installDirs[winner];
  assert.ok(!existsSync(join(installDirs[1 - winner], ".deploy/active")), "the losing directory cannot accept an existing project");
  assert.equal(readFileSync(join(installDir, ".deploy/active"), "utf8").trim(), "v0.1.0");
  assert.equal(statSync(commandPath(installDir)).mode & 0o777, 0o755);
  const commandHelp = helper(["help"], { entry: commandPath(installDir) });
  assert.match(commandHelp.stdout, /pp update/);
  const commandStatus = helper(["status"], { entry: commandPath(installDir) });
  assert.match(commandStatus.stdout, /v0\.1\.0/);
  assert.ok(commandStatus.stdout.includes(installDir), "command is bound to the actual winning installation directory");
  const unchangedDatabase = inspectService(project, "database").Id;
  const unchangedBackend = inspectService(project, "backend").State.StartedAt;
  helper(["update"], { entry: commandPath(installDir) });
  assert.equal(inspectService(project, "database").Id, unchangedDatabase);
  assert.equal(inspectService(project, "backend").State.StartedAt, unchangedBackend, "plain pp update is a healthy same-version no-op against the latest public release");
  const beforeDatabase = inspectService(project, "database");
  const beforeBackend = inspectService(project, "backend");
  const beforeVolumes = [beforeDatabase.Mounts.find(mount => mount.Destination === "/var/lib/postgresql/data").Name,
    beforeBackend.Mounts.find(mount => mount.Destination === "/workspace/storage").Name];
  let base = baseUrl(project);
  const cookie = await login(base);
  const marker = `deployment-data-${randomBytes(8).toString("hex")}`;
  const item = await json(base, "/api/apps/assets/items", { cookie, method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: marker }) }, 201);
  const bytes = Buffer.alloc(2 * 1024 * 1024 + 17, 0x6b);
  const form = new FormData();
  form.append("file", new Blob([bytes], { type: "application/octet-stream" }), "deployment-proof.bin");
  const attachment = await json(base, `/api/apps/assets/items/${item.id}/attachments`, { cookie, method: "POST", body: form }, 201);
  const attachmentPath = `/api/apps/assets/items/${item.id}/attachments/${attachment.id}`;
  await json(base, "/api/core/data/webdav", { cookie, method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ endpoint: "https://dav.example.invalid/backups/", username: "fixture-user", password: "fixture-webdav-password", scope: "own", intervalHours: 0 }) });
  const keyHash = docker(["exec", beforeBackend.Id, "sha256sum", "/workspace/storage/.core/backup.key"]).stdout.split(" ")[0];
  const savedEnv = readFileSync(join(installDir, ".env.release"), "utf8");
  assert.match(savedEnv, /DEPLOY_PRESERVATION_PROBE='keep this custom value'/);
  assert.equal(statSync(join(installDir, ".env.release")).mode & 0o777, 0o600);

  const shimDir = join(temporary, "shim");
  mkdirSync(shimDir);
  const failureMarker = join(temporary, "fail-after-up");
  const pullFailure = join(temporary, "fail-pull");
  const dumpFailure = join(temporary, "fail-dump");
  const stopCrash = join(temporary, "crash-after-stop");
  writeFileSync(join(shimDir, "docker"), `#!/usr/bin/env bash\nif [[ $1 == pull && -f '${pullFailure}' ]]; then rm -f '${pullFailure}'; exit 93; fi\nif [[ $1 == compose && " $* " == *" exec "* && " $* " == *" database "* && " $* " == *"pg_dump"* && -f '${dumpFailure}' ]]; then rm -f '${dumpFailure}'; exit 94; fi\n/usr/local/bin/docker "$@"\nstatus=$?\nif [[ $status == 0 && $1 == compose && " $* " == *" stop "* && " $* " == *" frontend backend "* && -f '${stopCrash}' ]]; then rm -f '${stopCrash}'; /usr/local/bin/docker kill --signal KILL '${helperName}' >/dev/null; exit 137; fi\nif [[ $status == 0 && " $* " == *" up "* && " $* " == *" --no-deps "* && -f '${failureMarker}' ]]; then rm -f '${failureMarker}'; exit 97; fi\nexit "$status"\n`, { mode: 0o755 });
  console.log("Checking a failed preflight pull leaves the accepted application running");
  const beforePull = inspectService(project, "backend").State.StartedAt;
  writeFileSync(pullFailure, "once\n");
  assert.notEqual(helper(["update", "--version", "v0.1.1", "--bundle-dir", fixtureDirs["v0.1.1"]], { entry: commandPath(installDir), failure: true, shim: true }).status, 0);
  assert.ok(!existsSync(join(installDir, ".deploy/pending")));
  assert.equal(readFileSync(join(installDir, ".deploy/active"), "utf8").trim(), "v0.1.0");
  assert.equal(inspectService(project, "backend").State.StartedAt, beforePull);
  assert.equal((await json(baseUrl(project), `/api/apps/assets/items/${item.id}`, { cookie })).name, marker);

  console.log("Updating to a controlled newer fixture and checking data, identity, keys and backup");
  helper(["update", "--version", "v0.1.1", "--bundle-dir", fixtureDirs["v0.1.1"]], { entry: commandPath(installDir) });
  assert.equal(readFileSync(join(installDir, ".deploy/active"), "utf8").trim(), "v0.1.1");
  assert.equal(inspectService(project, "database").Id, beforeDatabase.Id, "application update must not replace the database container");
  const updatedBackend = inspectService(project, "backend");
  assert.equal(updatedBackend.Mounts.find(mount => mount.Destination === "/workspace/storage").Name, beforeVolumes[1]);
  assert.equal(inspectService(project, "database").Mounts.find(mount => mount.Destination === "/var/lib/postgresql/data").Name, beforeVolumes[0]);
  assert.equal(docker(["exec", updatedBackend.Id, "sha256sum", "/workspace/storage/.core/backup.key"]).stdout.split(" ")[0], keyHash);
  assert.equal(readFileSync(join(installDir, ".env.release"), "utf8"), savedEnv, "the fixture has the same images, so no private setting should change");
  base = baseUrl(project);
  assert.equal((await json(base, `/api/apps/assets/items/${item.id}`, { cookie })).name, marker, "stored session and row survive update");
  assert.equal(hash(Buffer.from(await (await request(base, attachmentPath, { cookie })).arrayBuffer())), hash(bytes));
  await login(base);
  const webdav = await json(base, "/api/core/data/webdav", { cookie });
  assert.equal(webdav.endpoint, "https://dav.example.invalid/backups/");
  const backups = backupDirectories();
  assert.equal(backups.length, 1);
  const backup = backups[0];
  assert.ok(existsSync(join(backup, "complete")));
  assert.match(readFileSync(join(backup, "database.sql"), "utf8"), new RegExp(marker));
  assert.equal(readFileSync(join(backup, "old.env"), "utf8"), savedEnv);
  const archived = command("tar", ["-tzf", join(backup, "storage.tar.gz")]).stdout;
  const keyEntry = archived.split("\n").find(name => name.endsWith(".core/backup.key"));
  assert.ok(keyEntry, "full storage backup includes the WebDAV encryption key");
  const archivedKey = spawnSync("tar", ["-xOzf", join(backup, "storage.tar.gz"), keyEntry]);
  assert.equal(archivedKey.status, 0);
  assert.equal(hash(archivedKey.stdout), keyHash);
  assert.ok(existsSync(join(backup, "config")));
  assert.equal(statSync(backup).mode & 0o077, 0, "backup is private");

  const startedAt = updatedBackend.State.StartedAt;
  console.log("Checking kernel lock contention and release on the accepted deployment");
  const lockReady = join(temporary, "lock-held");
  const holderName = `${helperName}-lock`;
  const holder = asynchronousHelper([`flock --no-fork '${installDir}/.deploy.lock' sh -c 'touch "${lockReady}"; exec sleep 120'`], { name: holderName, entry: "-c" });
  for (let attempt = 0; attempt < 100 && !existsSync(lockReady); attempt++) await new Promise(resolve => setTimeout(resolve, 100));
  assert.ok(existsSync(lockReady), "lock holder acquired the real kernel lock");
  assert.notEqual(helper(["--dir", installDir, "--version", "v0.1.1", "--bundle-dir", fixtureDirs["v0.1.1"]], { failure: true }).status, 0);
  assert.equal(inspectService(project, "backend").State.StartedAt, startedAt);
  docker(["rm", "-f", holderName]);
  await holder.completion;
  helper(["update", "--version", "v0.1.1", "--bundle-dir", fixtureDirs["v0.1.1"]], { entry: commandPath(installDir) });
  assert.equal(inspectService(project, "backend").State.StartedAt, startedAt, "same-version rerun must not restart applications");
  assert.equal(backupDirectories().length, 1);

  console.log("Checking command registration locking and foreign-deployment conflicts before application mutation");
  const commandLockReady = join(temporary, "command-lock-held");
  const commandHolderName = `${helperName}-command-lock`;
  const commandHolder = asynchronousHelper([`flock --no-fork '${join(commandDirectory(installDir), ".personalplatform-pp.lock")}' sh -c 'touch "${commandLockReady}"; exec sleep 120'`], { name: commandHolderName, entry: "-c" });
  for (let attempt = 0; attempt < 100 && !existsSync(commandLockReady); attempt++) await new Promise(resolve => setTimeout(resolve, 100));
  assert.ok(existsSync(commandLockReady), "command registration lock holder acquired the real kernel lock");
  const commandBefore = hash(readFileSync(commandPath(installDir)));
  const blockedCommand = helper(["update", "--version", "v0.1.1", "--bundle-dir", fixtureDirs["v0.1.1"]], { entry: commandPath(installDir), failure: true });
  assert.notEqual(blockedCommand.status, 0);
  assert.match(blockedCommand.stderr, /command directory lock/);
  const foreignDirectory = join(temporary, "command-collision");
  const foreignArgs = ["--dir", foreignDirectory, "--command-dir", commandDirectory(installDir), "--version", "v0.1.0", "--env-file", initialEnv];
  const blockedForeign = helper(foreignArgs, { failure: true });
  assert.notEqual(blockedForeign.status, 0);
  assert.match(blockedForeign.stderr, /command directory lock/);
  docker(["rm", "-f", commandHolderName]);
  await commandHolder.completion;
  const foreign = helper(foreignArgs, { failure: true });
  assert.notEqual(foreign.status, 0);
  assert.match(foreign.stderr, /Refusing unrelated, modified or foreign command/);
  assert.equal(hash(readFileSync(commandPath(installDir))), commandBefore);
  assert.ok(!existsSync(join(foreignDirectory, ".deploy/active")));
  assert.equal(inspectService(project, "backend").State.StartedAt, startedAt);
  assert.equal(readFileSync(join(installDir, ".env.release"), "utf8"), savedEnv);
  helper(["update", "--version", "v0.1.1", "--bundle-dir", fixtureDirs["v0.1.1"]], { entry: commandPath(installDir) });

  writeFileSync(failureMarker, "once\n");
  console.log("Simulating a lost acknowledgement after target startup, then explicitly resuming forward");
  const failed = helper(["update", "--version", "v0.1.2", "--bundle-dir", fixtureDirs["v0.1.2"]], { entry: commandPath(installDir), failure: true, shim: true });
  assert.notEqual(failed.status, 0);
  assert.equal(readFileSync(join(installDir, ".deploy/active"), "utf8").trim(), "v0.1.1");
  assert.ok(existsSync(join(installDir, ".deploy/pending")));
  assert.equal(inspectService(project, "database").Id, beforeDatabase.Id);
  for (const service of ["backend", "frontend"]) assert.equal(inspectService(project, service).State.Running, false, "ambiguous update must stop writers");
  assert.notEqual(helper(["update", "--version", "v0.1.2", "--bundle-dir", fixtureDirs["v0.1.2"]], { entry: commandPath(installDir), failure: true }).status, 0, "ordinary rerun cannot bypass the failed-operation journal");
  const backupCount = backupDirectories().length;
  helper(["resume"], { entry: commandPath(installDir) });
  assert.equal(readFileSync(join(installDir, ".deploy/active"), "utf8").trim(), "v0.1.2");
  assert.ok(!existsSync(join(installDir, ".deploy/pending")));
  assert.equal(backupDirectories().length, backupCount, "resume reuses the matching pre-update backup");
  base = baseUrl(project);
  assert.equal((await json(base, `/api/apps/assets/items/${item.id}`, { cookie })).name, marker);
  assert.equal(hash(Buffer.from(await (await request(base, attachmentPath, { cookie })).arrayBuffer())), hash(bytes));
  cleanProject(project);

  console.log("Adopting an explicitly selected existing manual release deployment");
  const manual = join(temporary, "manual");
  mkdirSync(join(manual, "docker"), { recursive: true });
  for (const file of ["docker-compose.release.yml", "docker-compose.runtime.yml"]) copyFileSync(join(officialBundle, "docker", file), join(manual, "docker", file));
  for (const file of ["release.json", ".env.release.example", "README.md", "SHA256SUMS"]) copyFileSync(join(officialBundle, file), join(manual, file));
  envFile(join(manual, ".env.release"), projects[1], template);
  const manualCompose = ["compose", "--project-name", projects[1], "--env-file", join(manual, ".env.release"), "-f", join(manual, "docker/docker-compose.release.yml")];
  docker([...manualCompose, "up", "-d", "--no-build", "--wait", "--wait-timeout", "180"]);
  const manualDatabase = inspectService(projects[1], "database").Id;
  const manualCookie = await login(baseUrl(projects[1]));
  const manualItem = await json(baseUrl(projects[1]), "/api/apps/assets/items", { cookie: manualCookie, method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: `${marker}-manual` }) }, 201);
  helper(["--dir", manual, "--adopt", "--version", "v0.1.0", "--bundle-dir", official]);
  assert.ok(helper(["status"], { entry: commandPath(manual) }).stdout.includes(manual), "adoption binds a separate command to the real manual directory");
  assert.equal(inspectService(projects[1], "database").Id, manualDatabase);
  assert.equal((await json(baseUrl(projects[1]), `/api/apps/assets/items/${manualItem.id}`, { cookie: manualCookie })).name, `${marker}-manual`);
  console.log("Recovering an interrupted preparation on an adopted deployment, with a pre-start backup failure");
  const manualBackend = inspectService(projects[1], "backend");
  const manualFrontend = inspectService(projects[1], "frontend");
  const manualEnv = readFileSync(join(manual, ".env.release"), "utf8");
  writeFileSync(stopCrash, "once\n");
  assert.notEqual(helper(["--dir", manual, "--version", "v0.1.1", "--bundle-dir", fixtureDirs["v0.1.1"]], { failure: true, shim: true }).status, 0);
  assert.equal(readFileSync(join(manual, ".deploy/pending/phase"), "utf8").trim(), "preparing");
  assert.equal(readFileSync(join(manual, ".deploy/active"), "utf8").trim(), "v0.1.0");
  for (const service of ["backend", "frontend"]) assert.equal(inspectService(projects[1], service).State.Running, false);
  writeFileSync(dumpFailure, "once\n");
  assert.notEqual(helper(["resume"], { entry: commandPath(manual), failure: true, shim: true }).status, 0);
  assert.ok(!existsSync(join(manual, ".deploy/pending")), "known pre-start backup failure returns to the accepted deployment");
  await waitHealthy(projects[1]);
  for (const [service, original] of [["backend", manualBackend], ["frontend", manualFrontend]]) {
    const restored = inspectService(projects[1], service);
    assert.equal(restored.Id, original.Id, "preparing recovery retains the original app container");
    assert.equal(restored.Config.Labels["com.docker.compose.project.config_files"], original.Config.Labels["com.docker.compose.project.config_files"]);
  }
  assert.equal(inspectService(projects[1], "database").Id, manualDatabase);
  assert.equal(readFileSync(join(manual, ".env.release"), "utf8"), manualEnv);
  assert.equal((await json(baseUrl(projects[1]), `/api/apps/assets/items/${manualItem.id}`, { cookie: manualCookie })).name, `${marker}-manual`);
  assert.ok(readdirSync(join(manual, "backups")).length >= 2, "incomplete backup artifacts survive interrupted preparation and the failed retry");
  helper(["--dir", manual, "--version", "v0.1.1", "--bundle-dir", fixtureDirs["v0.1.1"]]);
  assert.equal(inspectService(projects[1], "database").Id, manualDatabase);
  assert.equal((await json(baseUrl(projects[1]), `/api/apps/assets/items/${manualItem.id}`, { cookie: manualCookie })).name, `${marker}-manual`);
  assert.equal(hash(readFileSync(join(root, "scripts/deploy.sh"))), installerSha256, "installer changed during acceptance; rerun the final source snapshot");
  writeFileSync(join(temporary, "RESULT.json"), `${JSON.stringify({ result: "PASS", installerSha256, publicVersion: "v0.1.0", fixtureVersions: ["v0.1.1", "v0.1.2"], project, checks: ["concurrent-directory-ownership", "install", "command-install-binding", "command-update-status-resume", "command-registration-lock-release-conflicts", "matching-backup", "data-session-attachment-key-preservation", "database-identity", "kernel-lock-release", "no-op", "preflight-pull-failure", "ambiguous-start-failure", "forward-resume", "manual-adoption", "interrupted-preparation", "backup-failure-recovery"] }, null, 2)}\n`, { mode: 0o600 });
  console.log(`PASS: isolated Linux install/update/adoption, matching backup, data/session/attachment/key persistence and forward recovery (${temporary})`);
} catch (error) {
  console.error(`FAIL: ${error.message}; private evidence retained in ${temporary}`);
  process.exitCode = 1;
  // Keep useful health/startup evidence before removing only this run's owned
  // projects. Inspect State only, so container environment is not logged.
  for (const owner of projects) {
    try {
      const ids = docker(["ps", "-aq", "--filter", `label=com.docker.compose.project=${owner}`], { failure: true }).stdout.split(/\s+/).filter(Boolean);
      for (const id of ids) {
        docker(["inspect", "--format", "{{json .State}}", id], { failure: true });
        docker(["logs", "--tail", "100", id], { failure: true });
      }
    } catch { /* Diagnostic failure must not replace the acceptance failure. */ }
  }
} finally {
  cleanup();
}
