import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { after, test } from "node:test";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const temporary = mkdtempSync(resolve(tmpdir(), "pp-compose-config-"));
const emptyEnv = resolve(temporary, "empty.env");
writeFileSync(emptyEnv, "");
after(() => rmSync(temporary, { recursive: true, force: true }));

// Explicit values override the caller's development/production environment.
const environment = {
  ...process.env,
  COMPOSE_PROJECT_NAME: "pp-config-test",
  POSTGRES_DB: "personal_platform",
  POSTGRES_USER: "personal_platform",
  POSTGRES_PASSWORD: "config-only-password",
  BOOTSTRAP_ADMIN_USERNAME: "config-admin",
  BOOTSTRAP_ADMIN_PASSWORD: "config-only-admin-password",
  BIND_IP: "127.0.0.1",
  FRONTEND_PORT: "5173",
  SESSION_COOKIE_SECURE: "",
  TRUST_PROXY: "",
};

function config(files, overrides = {}) {
  const result = spawnSync("docker", [
    "compose", "--env-file", emptyEnv,
    ...files.flatMap((file) => ["-f", resolve(root, file)]),
    "config", "--format", "json",
  ], { cwd: root, env: { ...environment, ...overrides }, encoding: "utf8" });
  if (result.error) throw result.error;
  return result;
}

test("production is standalone, uses the repository build context and only persistent data mounts", () => {
  const result = config(["docker/docker-compose.prod.yml"]);
  assert.equal(result.status, 0, result.stderr);
  const { services } = JSON.parse(result.stdout);
  for (const id of ["backend", "frontend"]) {
    assert.equal(services[id].build.context, root);
    assert.ok(services[id].build.dockerfile.endsWith(`${id}.prod.Dockerfile`));
    assert.ok((services[id].volumes ?? []).every((mount) => mount.type === "volume"));
  }
  assert.equal(services.backend.ports?.length ?? 0, 0);
  assert.equal(services.database.ports?.length ?? 0, 0);
  assert.equal(services.frontend.ports.length, 1);
  assert.equal(services.frontend.ports[0].host_ip, "127.0.0.1");
  assert.equal(services.frontend.ports[0].target, 8080);
  assert.ok(services.backend.volumes.some((mount) => mount.target === "/workspace/storage"));
  assert.ok(services.database.volumes.some((mount) => mount.target === "/var/lib/postgresql/data"));
  assert.equal(services.backend.environment.PLATFORM_ENVIRONMENT, "production");
  assert.equal(services.backend.environment.SESSION_COOKIE_SECURE, "true");
  const defaults = config(["docker/docker-compose.prod.yml"], { COMPOSE_PROJECT_NAME: "" });
  assert.equal(defaults.status, 0, defaults.stderr);
  assert.equal(JSON.parse(defaults.stdout).name, "personal-platform-production");
});

test("production rejects missing database and bootstrap credentials", () => {
  for (const variable of ["POSTGRES_DB", "POSTGRES_USER", "POSTGRES_PASSWORD", "BOOTSTRAP_ADMIN_USERNAME", "BOOTSTRAP_ADMIN_PASSWORD"]) {
    const result = config(["docker/docker-compose.prod.yml"], { [variable]: "" });
    assert.notEqual(result.status, 0, `${variable} must be explicit`);
    assert.ok(result.stderr.includes(variable));
  }
});

test("development retains live source mounts and private backend/database networking", () => {
  const result = config(["docker-compose.yml"]);
  assert.equal(result.status, 0, result.stderr);
  const { services } = JSON.parse(result.stdout);
  assert.ok(services.backend.volumes.some((mount) => mount.type === "bind" && mount.target === "/workspace/backend"));
  assert.ok(services.frontend.volumes.some((mount) => mount.type === "bind" && mount.target === "/workspace/frontend"));
  assert.equal(services.backend.build.dockerfile, "docker/backend.Dockerfile");
  assert.equal(services.frontend.build.dockerfile, "docker/frontend.Dockerfile");
  assert.equal(services.backend.ports?.length ?? 0, 0);
  assert.equal(services.database.ports?.length ?? 0, 0);
});

test("development exposure remains opt-in and loopback for backend/database", () => {
  const result = config(["docker-compose.yml", "docker/compose.expose.yml"], { EXPOSE_BIND_IP: "127.0.0.1" });
  assert.equal(result.status, 0, result.stderr);
  const { services } = JSON.parse(result.stdout);
  for (const id of ["backend", "database"]) {
    assert.equal(services[id].ports.length, 1);
    assert.equal(services[id].ports[0].host_ip, "127.0.0.1");
  }
});
