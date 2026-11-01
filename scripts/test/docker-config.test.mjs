import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { after, test } from "node:test";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const temporary = mkdtempSync(resolve(tmpdir(), "pp-compose-config-"));
const emptyEnv = resolve(temporary, "empty.env");
writeFileSync(emptyEnv, "");
after(() => rmSync(temporary, { recursive: true, force: true }));

test("production proxy admits a maximum Settings snapshot envelope without raising other API limits", () => {
  const nginx = readFileSync(resolve(root, "docker/nginx.conf"), "utf8");
  const dataLocation = nginx.match(/location \^~ \/api\/core\/data\/ \{([^}]+)\}/)?.[1];
  assert.ok(dataLocation, "Settings needs an explicit proxy upload budget");
  assert.match(dataLocation, /client_max_body_size 33m;/);
  assert.match(dataLocation, /proxy_read_timeout 360s;/);
  assert.match(dataLocation, /proxy_pass \$backend\$request_uri;/);
  assert.match(nginx, /client_max_body_size 12m;/);
});

test("WebDAV deployment policy and optional key reach the production backend", () => {
  const result = config(["docker/docker-compose.prod.yml"], {
    DATA_BACKUP_ALLOWED_ORIGINS: "https://nas.example:5006",
    DATA_BACKUP_ENCRYPTION_KEY: "test-config-only-key",
  });
  assert.equal(result.status, 0, result.stderr);
  const backend = JSON.parse(result.stdout).services.backend.environment;
  assert.equal(backend.DATA_BACKUP_ALLOWED_ORIGINS, "https://nas.example:5006");
  assert.equal(backend.DATA_BACKUP_ENCRYPTION_KEY, "test-config-only-key");
});

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
  DATABASE_POOL_MAX: undefined,
  PG_SHARED_BUFFERS: undefined,
  PG_WORK_MEM: undefined,
  PG_MAINTENANCE_WORK_MEM: undefined,
  PG_MAX_CONNECTIONS: undefined,
  HEALTHCHECK_INTERVAL: undefined,
  DATABASE_MEMORY_LIMIT: undefined,
  BACKEND_MEMORY_LIMIT: undefined,
  FRONTEND_MEMORY_LIMIT: undefined,
  DATABASE_CPU_LIMIT: undefined,
  BACKEND_CPU_LIMIT: undefined,
  FRONTEND_CPU_LIMIT: undefined,
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

test("production waits for PostgreSQL TCP readiness after the socket-only initialization server", () => {
  const result = config(["docker/docker-compose.prod.yml"]);
  assert.equal(result.status, 0, result.stderr);
  const { services } = JSON.parse(result.stdout);
  const probe = services.database.healthcheck.test.join(" ");
  assert.match(probe, /pg_isready\s+-h\s+127\.0\.0\.1\b/, "a Unix socket can become ready before the backend can connect over TCP");
  assert.equal(services.backend.depends_on.database.condition, "service_healthy");
});

test("production defaults bound connection overhead, probe processes and logs without lowering resource ceilings", () => {
  const result = config(["docker/docker-compose.prod.yml"]);
  assert.equal(result.status, 0, result.stderr);
  const { services } = JSON.parse(result.stdout);
  assert.equal(services.backend.environment.DATABASE_POOL_MAX, "4");
  assert.deepEqual(services.database.command, ["postgres", "-c", "shared_buffers=64MB", "-c", "work_mem=2MB", "-c", "maintenance_work_mem=32MB", "-c", "max_connections=30"]);
  for (const service of Object.values(services)) {
    assert.equal(service.healthcheck.interval, "30s");
    assert.equal(service.healthcheck.retries, 10);
    assert.deepEqual(service.logging, { driver: "json-file", options: { "max-file": "3", "max-size": "10m" } });
  }
  assert.deepEqual(services.backend.healthcheck.test, ["CMD", "wget", "-q", "-T", "2", "-O", "/dev/null", "http://127.0.0.1:8000/api/core/health/ready"]);
  assert.equal(services.database.deploy.resources.limits.memory, "1073741824");
  assert.equal(services.backend.deploy.resources.limits.memory, "536870912");
  assert.equal(services.frontend.deploy.resources.limits.memory, "268435456");
});

test("production resource settings can be overridden independently and empty pool overrides reach validation", () => {
  const result = config(["docker/docker-compose.prod.yml"], {
    DATABASE_POOL_MAX: "10", PG_SHARED_BUFFERS: "128MB", PG_WORK_MEM: "4MB", PG_MAINTENANCE_WORK_MEM: "64MB", PG_MAX_CONNECTIONS: "100",
    HEALTHCHECK_INTERVAL: "5s", DATABASE_MEMORY_LIMIT: "768M", BACKEND_MEMORY_LIMIT: "384M", FRONTEND_MEMORY_LIMIT: "128M",
    DATABASE_CPU_LIMIT: "0.75", BACKEND_CPU_LIMIT: "0.8", FRONTEND_CPU_LIMIT: "0.25",
  });
  assert.equal(result.status, 0, result.stderr);
  const { services } = JSON.parse(result.stdout);
  assert.equal(services.backend.environment.DATABASE_POOL_MAX, "10");
  assert.deepEqual(services.database.command, ["postgres", "-c", "shared_buffers=128MB", "-c", "work_mem=4MB", "-c", "maintenance_work_mem=64MB", "-c", "max_connections=100"]);
  for (const service of Object.values(services)) assert.equal(service.healthcheck.interval, "5s");
  for (const [name, memory, cpus] of [["database", 768, "0.75"], ["backend", 384, "0.8"], ["frontend", 128, "0.25"]]) {
    assert.equal(services[name].deploy.resources.limits.memory, String(memory * 1024 * 1024));
    assert.equal(Number(services[name].deploy.resources.limits.cpus), Number(cpus));
  }
  const empty = config(["docker/docker-compose.prod.yml"], { DATABASE_POOL_MAX: "" });
  assert.equal(empty.status, 0, empty.stderr);
  assert.equal(JSON.parse(empty.stdout).services.backend.environment.DATABASE_POOL_MAX, "");
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
