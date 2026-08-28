import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { semanticErrors, validateManifest } from "../../src/core/app-registry/manifest.js";

const validManifest = {
  manifest_version: 1,
  id: "assets",
  name: "Assets",
  version: "0.1.0",
  description: "Personal asset management",
  default_enabled: true,
  frontend: { route: "/assets" },
  widgets: [{ id: "summary", name: "Asset Summary" }],
  capabilities: { database: true, storage: true, scheduler: false, events: true },
};

describe("manifest validation", () => {
  it("accepts a valid manifest and fills capability defaults", () => {
    const result = validateManifest({ ...validManifest, capabilities: {} });
    assert.ok(result.ok);
    assert.equal(result.manifest.id, "assets");
    assert.deepEqual(result.manifest.capabilities, {
      database: false,
      storage: false,
      scheduler: false,
      events: false,
    });
  });

  it("rejects unsupported manifest_version", () => {
    const result = validateManifest({ ...validManifest, manifest_version: 2 });
    assert.ok(!result.ok);
    assert.ok(result.errors.some((e) => e.includes("manifest_version")));
  });

  it("rejects ids with invalid characters", () => {
    const result = validateManifest({ ...validManifest, id: "My-App" });
    assert.ok(!result.ok);
    assert.ok(result.errors.some((e) => e.includes("id")));
  });

  it("rejects missing required fields", () => {
    const { id: _id, ...missingId } = validManifest;
    const result = validateManifest(missingId);
    assert.ok(!result.ok);
    assert.ok(result.errors.some((e) => e.includes("id")));
  });

  it("rejects non-semver versions", () => {
    const result = validateManifest({ ...validManifest, version: "latest" });
    assert.ok(!result.ok);
    assert.ok(result.errors.some((e) => e.includes("version")));
  });

  it("rejects unknown top-level keys", () => {
    const result = validateManifest({ ...validManifest, mystery: true });
    assert.ok(!result.ok);
  });

  it("rejects non-mapping input", () => {
    const result = validateManifest("nope");
    assert.ok(!result.ok);
    assert.equal(result.errors.length, 1);
  });
});

describe("manifest semantic rules", () => {
  it("requires the route to live under /<app_id>", () => {
    const result = validateManifest({
      ...validManifest,
      frontend: { route: "/somewhere-else" },
    });
    assert.ok(result.ok);
    const errors = semanticErrors(result.manifest);
    assert.ok(errors.some((e) => e.includes("/assets")));
  });

  it("rejects duplicate widget ids within one app", () => {
    const result = validateManifest({
      ...validManifest,
      widgets: [
        { id: "summary", name: "A" },
        { id: "summary", name: "B" },
      ],
    });
    assert.ok(result.ok);
    const errors = semanticErrors(result.manifest);
    assert.ok(errors.some((e) => e.includes("duplicate widget")));
  });
});
