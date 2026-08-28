import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { findRepoRoot, loadAppConfig, loadConfig } from "../../src/core/config/index.js";

const root = mkdtempSync(join(tmpdir(), "pp-config-"));
after(() => rmSync(root, { recursive: true, force: true }));

function writePlatformYaml(content: string): void {
  mkdirSync(join(root, "config"), { recursive: true });
  mkdirSync(join(root, "apps"), { recursive: true });
  writeFileSync(join(root, "config", "platform.yaml"), content);
}

describe("platform config", () => {
  it("loads and validates platform.yaml", () => {
    writePlatformYaml(`
platform:
  name: Test Platform
  environment: test
apps:
  manifests_directory: apps
  enabled:
    assets: false
storage:
  driver: local
  root: storage
`);
    const previous = process.env.PLATFORM_ROOT;
    process.env.PLATFORM_ROOT = root;
    try {
      const config = loadConfig();
      assert.equal(config.platform.name, "Test Platform");
      assert.equal(config.apps.manifests_directory, "apps");
      assert.equal(config.apps.enabled?.assets, false);
      assert.equal(config.storage.driver, "local");
      assert.equal(findRepoRoot(), root);
      assert.deepEqual(loadAppConfig("nonexistent"), {});
    } finally {
      if (previous === undefined) delete process.env.PLATFORM_ROOT;
      else process.env.PLATFORM_ROOT = previous;
    }
  });

  it("applies defaults for optional values", () => {
    writePlatformYaml("platform:\n  name: Minimal\n");
    const previous = process.env.PLATFORM_ROOT;
    process.env.PLATFORM_ROOT = root;
    try {
      const config = loadConfig();
      assert.equal(config.apps.manifests_directory, "apps");
      assert.deepEqual(config.apps.enabled, {});
      assert.equal(config.storage.root, "storage");
    } finally {
      if (previous === undefined) delete process.env.PLATFORM_ROOT;
      else process.env.PLATFORM_ROOT = previous;
    }
  });

  it("throws when platform.yaml is not a mapping", () => {
    writePlatformYaml("- just\n- a\n- list\n");
    const previous = process.env.PLATFORM_ROOT;
    process.env.PLATFORM_ROOT = root;
    try {
      assert.throws(() => loadConfig(), /mapping/);
    } finally {
      if (previous === undefined) delete process.env.PLATFORM_ROOT;
      else process.env.PLATFORM_ROOT = previous;
    }
  });
});
