import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { parse } from "yaml";

export interface PlatformConfig {
  platform: { name: string; environment: string };
  apps: { manifests_directory: string; enabled?: Record<string, boolean> };
  storage: { driver: string; root: string };
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
