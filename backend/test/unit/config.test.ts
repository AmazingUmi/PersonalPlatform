import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import {
  findRepoRoot,
  loadAppConfig,
  loadConfig,
  resolveEnvironment,
  resolveSessionCookieSecure,
  resolveTrustProxy,
} from "../../src/core/config/index.js";

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

  it("parses platform.trust_proxy from the yaml config (AUTH-H1-03)", () => {
    writePlatformYaml("platform:\n  name: Proxied\n  trust_proxy: loopback\n");
    const previous = process.env.PLATFORM_ROOT;
    process.env.PLATFORM_ROOT = root;
    try {
      const config = loadConfig();
      assert.equal(config.platform.trustProxy, "loopback");
    } finally {
      if (previous === undefined) delete process.env.PLATFORM_ROOT;
      else process.env.PLATFORM_ROOT = previous;
    }
  });
});

/**
 * AUTH-H1-02 / H1-03 unit coverage: environment-variable overrides with
 * explicit precedence (env > yaml), the session-cookie Secure flag, and the
 * Fastify trustProxy resolution. All resolvers are pure — the env object is
 * injected, never the real process environment.
 */
describe("resolveEnvironment (AUTH-H1-02)", () => {
  it("falls back to the yaml-configured environment when the env var is unset", () => {
    assert.equal(resolveEnvironment("development", {}), "development");
    assert.equal(resolveEnvironment("production", {}), "production");
  });

  it("PLATFORM_ENVIRONMENT overrides the yaml value (env > yaml)", () => {
    assert.equal(resolveEnvironment("development", { PLATFORM_ENVIRONMENT: "production" }), "production");
    assert.equal(resolveEnvironment("production", { PLATFORM_ENVIRONMENT: "development" }), "development");
  });

  it("an empty/whitespace env var does not override", () => {
    assert.equal(resolveEnvironment("development", { PLATFORM_ENVIRONMENT: "" }), "development");
    assert.equal(resolveEnvironment("development", { PLATFORM_ENVIRONMENT: "  " }), "development");
  });
});

describe("resolveSessionCookieSecure (AUTH-H1-02)", () => {
  it("development → Secure=false (plain-HTTP dev flow works)", () => {
    assert.equal(resolveSessionCookieSecure("development", {}), false);
  });

  it("production → Secure=true", () => {
    assert.equal(resolveSessionCookieSecure("production", {}), true);
  });

  it("PLATFORM_ENVIRONMENT=production upgrades a development yaml config", () => {
    assert.equal(
      resolveSessionCookieSecure("development", { PLATFORM_ENVIRONMENT: "production" }),
      true,
    );
  });

  it("PLATFORM_ENVIRONMENT=development downgrades a production yaml config", () => {
    assert.equal(
      resolveSessionCookieSecure("production", { PLATFORM_ENVIRONMENT: "development" }),
      false,
    );
  });

  it("SESSION_COOKIE_SECURE=true forces Secure even in development", () => {
    assert.equal(resolveSessionCookieSecure("development", { SESSION_COOKIE_SECURE: "true" }), true);
  });

  it("SESSION_COOKIE_SECURE=false is the only way to withhold Secure in production", () => {
    assert.equal(resolveSessionCookieSecure("production", { SESSION_COOKIE_SECURE: "false" }), false);
  });

  it("SESSION_COOKIE_SECURE wins over PLATFORM_ENVIRONMENT (explicit > derived)", () => {
    assert.equal(
      resolveSessionCookieSecure("development", {
        SESSION_COOKIE_SECURE: "false",
        PLATFORM_ENVIRONMENT: "production",
      }),
      false,
    );
    assert.equal(
      resolveSessionCookieSecure("production", {
        SESSION_COOKIE_SECURE: "true",
        PLATFORM_ENVIRONMENT: "development",
      }),
      true,
    );
  });

  it("rejects a non-boolean SESSION_COOKIE_SECURE instead of guessing", () => {
    assert.throws(() => resolveSessionCookieSecure("production", { SESSION_COOKIE_SECURE: "maybe" }));
  });

  it("accepts common boolean spellings", () => {
    assert.equal(resolveSessionCookieSecure("development", { SESSION_COOKIE_SECURE: "1" }), true);
    assert.equal(resolveSessionCookieSecure("development", { SESSION_COOKIE_SECURE: "on" }), true);
    assert.equal(resolveSessionCookieSecure("production", { SESSION_COOKIE_SECURE: "0" }), false);
    assert.equal(resolveSessionCookieSecure("production", { SESSION_COOKIE_SECURE: "off" }), false);
  });
});

describe("resolveTrustProxy (AUTH-H1-03)", () => {
  it("defaults to false — forwarded headers are ignored without configuration", () => {
    assert.equal(resolveTrustProxy(undefined, {}), false);
    assert.equal(resolveTrustProxy(undefined, { TRUST_PROXY: "" }), false);
    assert.equal(resolveTrustProxy(undefined, { TRUST_PROXY: "  " }), false);
  });

  it("explicit false/0 stays off", () => {
    assert.equal(resolveTrustProxy(undefined, { TRUST_PROXY: "false" }), false);
    assert.equal(resolveTrustProxy("true", { TRUST_PROXY: "0" }), false);
  });

  it("true/1 trusts every peer (only safe behind a backend unreachable except via the proxy)", () => {
    assert.equal(resolveTrustProxy(undefined, { TRUST_PROXY: "true" }), true);
    assert.equal(resolveTrustProxy(undefined, { TRUST_PROXY: "1" }), true);
  });

  it("passes proxy-addr trust expressions through verbatim", () => {
    assert.equal(resolveTrustProxy(undefined, { TRUST_PROXY: "loopback" }), "loopback");
    assert.equal(resolveTrustProxy(undefined, { TRUST_PROXY: "uniquelocal" }), "uniquelocal");
    assert.equal(
      resolveTrustProxy(undefined, { TRUST_PROXY: "172.16.0.0/12,127.0.0.1" }),
      "172.16.0.0/12,127.0.0.1",
    );
  });

  it("TRUST_PROXY env wins over the yaml platform.trust_proxy value", () => {
    assert.equal(resolveTrustProxy("loopback", { TRUST_PROXY: "uniquelocal" }), "uniquelocal");
  });

  it("uses the yaml value when the env var is unset", () => {
    assert.equal(resolveTrustProxy("loopback", {}), "loopback");
  });
});
