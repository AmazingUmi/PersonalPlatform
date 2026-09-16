import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { parse } from "yaml";

export interface PlatformConfig {
  /** `timezone` is an IANA name (Asia/Shanghai); never a UTC+8 style offset. */
  platform: { name: string; environment: string; timezone?: string; trustProxy?: string };
  apps: { manifests_directory: string; enabled?: Record<string, boolean> };
  storage: { driver: string; root: string };
}

type Env = Record<string, string | undefined>;

function envFlag(env: Env, name: string): boolean | undefined {
  const raw = env[name]?.trim().toLowerCase();
  if (raw === undefined || raw === "") return undefined;
  if (raw === "true" || raw === "1" || raw === "yes" || raw === "on") return true;
  if (raw === "false" || raw === "0" || raw === "no" || raw === "off") return false;
  throw new Error(`${name} must be a boolean (true/false), got "${env[name]}"`);
}

/**
 * Effective environment (AUTH-H1-02): the `PLATFORM_ENVIRONMENT` env var
 * overrides the `platform.environment` yaml default (env > yaml), so Docker
 * deployments can reliably declare production without editing the checked-in
 * config.
 */
export function resolveEnvironment(configured: string, env: Env = process.env): string {
  return env.PLATFORM_ENVIRONMENT?.trim() || configured;
}

/**
 * Session cookie Secure flag (AUTH-H1-02). Precedence:
 *   SESSION_COOKIE_SECURE=true|false (explicit operator intent)
 *   > PLATFORM_ENVIRONMENT env
 *   > platform.environment yaml
 * The flag is NEVER guessed from request headers, and a misconfigured reverse
 * proxy cannot downgrade it: `false` is only honored when written explicitly.
 */
export function resolveSessionCookieSecure(
  configuredEnvironment: string,
  env: Env = process.env,
): boolean {
  const explicit = envFlag(env, "SESSION_COOKIE_SECURE");
  if (explicit !== undefined) return explicit;
  return resolveEnvironment(configuredEnvironment, env) === "production";
}

/**
 * Fastify `trustProxy` resolution (AUTH-H1-03). Precedence: `TRUST_PROXY` env
 * > `platform.trust_proxy` yaml. Unset/false/0 → `false` (default: forwarded
 * headers are ignored — safe with no configuration). true/1 → `true` (trust
 * every peer; ONLY safe when the backend is reachable solely through the
 * proxy). Any other string is forwarded verbatim to Fastify/proxy-addr
 * (`loopback`, `uniquelocal`, or an IP/CIDR list) — only requests from those
 * addresses get their X-Forwarded-For honored, so direct clients cannot spoof.
 */
export function resolveTrustProxy(
  configured: string | undefined,
  env: Env = process.env,
): boolean | string {
  const raw = env.TRUST_PROXY?.trim() || configured?.trim();
  if (raw === undefined || raw === "") return false;
  const lowered = raw.toLowerCase();
  if (lowered === "false" || lowered === "0") return false;
  if (lowered === "true" || lowered === "1") return true;
  return raw;
}

/**
 * Locate the repository root by walking up from `start` until a directory that
 * contains both `config/platform.yaml` and `apps/` is found. Can be overridden
 * with the `PLATFORM_ROOT` environment variable.
 */
export function findRepoRoot(start: string = process.cwd()): string {
  const override = process.env.PLATFORM_ROOT;
  if (override) return resolve(override);

  let dir = resolve(start);
  for (let i = 0; i < 64; i += 1) {
    if (existsSync(join(dir, "config", "platform.yaml")) && existsSync(join(dir, "apps"))) {
      return dir;
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  throw new Error("Could not locate platform root (expected config/platform.yaml and apps/)");
}

export function loadConfig(): PlatformConfig {
  const root = findRepoRoot();
  const raw = readFileSync(join(root, "config", "platform.yaml"), "utf8");
  const parsed = parse(raw) as Record<string, unknown>;

  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error("config/platform.yaml must contain a YAML mapping");
  }

  const platform = (parsed["platform"] ?? {}) as Record<string, unknown>;
  const apps = (parsed["apps"] ?? {}) as Record<string, unknown>;
  const storage = (parsed["storage"] ?? {}) as Record<string, unknown>;

  return {
    platform: {
      name: String(platform["name"] ?? "Personal Platform"),
      environment: String(platform["environment"] ?? "development"),
      timezone: platform["timezone"] === undefined ? undefined : String(platform["timezone"]),
      trustProxy:
        platform["trust_proxy"] === undefined ? undefined : String(platform["trust_proxy"]),
    },
    apps: {
      manifests_directory: String(apps["manifests_directory"] ?? "apps"),
      enabled: (apps["enabled"] as Record<string, boolean> | undefined) ?? {},
    },
    storage: {
      driver: String(storage["driver"] ?? "local"),
      root: String(storage["root"] ?? "storage"),
    },
  };
}

/** Load the optional per-app configuration file at `config/apps/<id>.yaml`. */
export function loadAppConfig(appId: string): Record<string, unknown> {
  const root = findRepoRoot();
  const path = join(root, "config", "apps", `${appId}.yaml`);
  if (!existsSync(path)) return {};
  const parsed = parse(readFileSync(path, "utf8")) as unknown;
  if (typeof parsed !== "object" || parsed === null) return {};
  return parsed as Record<string, unknown>;
}
