import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before } from "node:test";
import type { Platform } from "../../src/core/platform.js";
import { createPlatform } from "../../src/core/platform.js";
import type { PlatformConfig } from "../../src/core/config/index.js";
import { createLogger } from "../../src/core/logging/index.js";
import type { BackendAppModule } from "../../src/core/app-registry/types.js";
import type { Database } from "../../src/core/database/index.js";

export interface FixtureManifest {
  id: string;
  yaml?: string;
  migrations?: string[];
}

export interface FixtureOptions {
  manifests: FixtureManifest[];
  backendModules?: Record<string, BackendAppModule>;
  frontendAppIds?: string[];
  database: Database | null;
}

export function defaultManifestYaml(id: string): string {
  return `manifest_version: 1
id: ${id}
name: ${id.replace(/^./, (c) => c.toUpperCase())}
version: 0.1.0
description: test app ${id}
default_enabled: true
frontend:
  route: /${id}
widgets: []
capabilities:
  database: true
`;
}

/**
 * Build a real platform against a temp root with fixture manifests. Core
 * migrations must have been applied to `options.database` already.
 */
export async function buildFixturePlatform(options: FixtureOptions): Promise<{
  platform: Platform;
  root: string;
  cleanup: () => void;
}> {
  const root = mkdtempSync(join(tmpdir(), "pp-test-"));
  const manifestsDir = join(root, "apps");
  mkdirSync(manifestsDir, { recursive: true });
  mkdirSync(join(root, "storage"), { recursive: true });
  mkdirSync(join(root, "config"), { recursive: true });
  writeFileSync(join(root, "config", "platform.yaml"), "platform:\n  name: test\n");

  for (const fixture of options.manifests) {
    const appDir = join(manifestsDir, fixture.id);
    mkdirSync(appDir, { recursive: true });
    writeFileSync(join(appDir, "app.yaml"), fixture.yaml ?? defaultManifestYaml(fixture.id));
    if (fixture.migrations && fixture.migrations.length > 0) {
      const dir = join(appDir, "migrations");
      mkdirSync(dir, { recursive: true });
      for (const [index, sql] of fixture.migrations.entries()) {
        writeFileSync(join(dir, `2026010100000${index + 1}-step${index + 1}.sql`), sql);
      }
    }
  }

  const previousRoot = process.env.PLATFORM_ROOT;
  process.env.PLATFORM_ROOT = root;

  const config: PlatformConfig = {
    platform: { name: "test", environment: "test" },
    apps: { manifests_directory: "apps", enabled: {} },
    storage: { driver: "local", root: "storage" },
  };

  // Default: a no-op backend module per fixture app so statuses behave like
  // real compiled apps (apps without any module would be "installed").
  const backendModules = { ...options.backendModules };
  if (options.backendModules === undefined) {
    for (const fixture of options.manifests) {
      backendModules[fixture.id] = {
        id: fixture.id,
        async registerApi() {},
      };
    }
  }

  const platform = await createPlatform({
    config,
    root,
    log: createLogger("fatal"),
    database: options.database,
    backendModules,
    frontendAppIds: options.frontendAppIds ?? options.manifests.map((fixture) => fixture.id),
  });

  const cleanup = () => {
    if (previousRoot === undefined) delete process.env.PLATFORM_ROOT;
    else process.env.PLATFORM_ROOT = previousRoot;
    rmSync(root, { recursive: true, force: true });
  };
  return { platform, root, cleanup };
}

/** Build a fixture platform, run assertions, then stop and clean up. */
export async function withFixturePlatform(
  options: Omit<FixtureOptions, "database"> & { database?: Database | null },
  fn: (platform: Platform) => Promise<void>,
): Promise<void> {
  let fixture: Awaited<ReturnType<typeof buildFixturePlatform>> | undefined;
  try {
    fixture = await buildFixturePlatform({ ...options, database: options.database ?? null });
    await fn(fixture.platform);
  } finally {
    if (fixture) {
      await fixture.platform.stop().catch(() => undefined);
      fixture.cleanup();
    }
  }
}

export { before, after };
