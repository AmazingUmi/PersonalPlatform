import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { describe, it } from "node:test";

/**
 * P4 completion criteria: apps use shared services only through AppContext —
 * no direct database drivers, no core internals, no cross-app imports.
 */
const appsDir = join(import.meta.dirname, "..", "..", "src", "apps");

async function appSourceFiles(): Promise<string[]> {
  const apps = await readdir(appsDir, { withFileTypes: true });
  const files: string[] = [];
  for (const app of apps) {
    if (!app.isDirectory()) continue;
    const entries = await readdir(join(appsDir, app.name), { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isFile() && entry.name.endsWith(".ts")) {
        files.push(join(appsDir, app.name, entry.name));
      }
    }
  }
  return files;
}

const FORBIDDEN_PATTERNS: Array<{ pattern: RegExp; reason: string }> = [
  { pattern: /from\s+"pg"|require\("pg"\)/, reason: "apps must not import pg directly" },
  { pattern: /from\s+"\.\.\/\.\.\/core\/database/, reason: "apps must use ctx.database, not core database internals" },
  { pattern: /new\s+Pool\(/, reason: "apps must not create their own pools" },
  { pattern: /from\s+"\.\.\/\.\.\/apps\/(?!)/, reason: "apps must not import other apps" },
];

describe("app isolation", () => {
  it("app modules only use shared services through AppContext", async () => {
    const files = await appSourceFiles();
    assert.ok(files.length > 0, "expected at least one app module");
    for (const file of files) {
      const source = await readFile(file, "utf8");
      for (const { pattern, reason } of FORBIDDEN_PATTERNS) {
        assert.ok(!pattern.test(source), `${file}: ${reason}`);
      }
    }
  });

  it("app modules do not write to other apps' schemas", async () => {
    const apps = await readdir(appsDir, { withFileTypes: true });
    for (const app of apps) {
      if (!app.isDirectory()) continue;
      const entries = await readdir(join(appsDir, app.name), { withFileTypes: true });
      for (const entry of entries) {
        if (!entry.isFile() || !entry.name.endsWith(".ts")) continue;
        const source = await readFile(join(appsDir, app.name, entry.name), "utf8");
        // Any schema-qualified SQL must reference the app's own schema only.
        const qualified = source.matchAll(/["']?(?:FROM|INTO|UPDATE|TABLE|JOIN)\s+([a-z_]+)\./g);
        for (const match of qualified) {
          assert.equal(
            match[1],
            app.name,
            `${app.name}/${entry.name} references schema "${match[1]}" of another app`,
          );
        }
      }
    }
  });
});
