import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { duplicateIds, scanApps } from "../../src/core/app-registry/scanner.js";

const root = mkdtempSync(join(tmpdir(), "pp-scan-"));
after(() => rmSync(root, { recursive: true, force: true }));

function writeApp(dir: string, yaml: string): void {
  mkdirSync(join(root, dir), { recursive: true });
  writeFileSync(join(root, dir, "app.yaml"), yaml);
}

const validYaml = (id: string) => `manifest_version: 1
id: ${id}
name: ${id}
version: 0.1.0
description: test
default_enabled: true
frontend: { route: /${id} }
capabilities: {}
`;

describe("app scanner", () => {
  it("collects valid manifests sorted by id", () => {
    writeApp("zeta", validYaml("zeta"));
    writeApp("alpha", validYaml("alpha"));
    const apps = scanApps(root);
    const ids = apps.map((app) => app.id);
    assert.deepEqual(ids, [...ids].sort());
    assert.ok(ids.includes("alpha"));
    assert.ok(ids.includes("zeta"));
    assert.equal(apps.find((app) => app.id === "alpha")?.manifest?.frontend.route, "/alpha");
  });

  it("reports invalid manifests without aborting the scan", () => {
    writeApp("broken", "id: [unclosed\nbad yaml: ::");
    writeApp("good_after_break", validYaml("good_after_break"));
    const apps = scanApps(root);
    const broken = apps.find((app) => app.directory === "broken");
    assert.ok(broken);
    assert.equal(broken?.manifest, null);
    assert.ok((broken?.errors.length ?? 0) > 0);
    const good = apps.find((app) => app.id === "good_after_break");
    assert.ok(good?.manifest, "other apps still scan after a broken manifest");
  });

  it("ignores directories starting with underscore and without app.yaml", () => {
    writeApp("_template", validYaml("template"));
    mkdirSync(join(root, "no_manifest"), { recursive: true });
    const apps = scanApps(root);
    assert.ok(!apps.some((app) => app.directory === "_template"));
    assert.ok(!apps.some((app) => app.directory === "no_manifest"));
  });

  it("detects duplicate ids across apps", () => {
    writeApp("dup_one", validYaml("duplicated"));
    writeApp("dup_two", validYaml("duplicated"));
    const dupes = duplicateIds(scanApps(root));
    assert.deepEqual(dupes, ["duplicated"]);
  });
});
