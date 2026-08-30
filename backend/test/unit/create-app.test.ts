import assert from "node:assert/strict";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { parse } from "yaml";
import ts from "typescript";
import { CreateAppError, runCreateApp } from "../../../scripts/create-app.js";
import { semanticErrors, validateManifest } from "../../src/core/app-registry/manifest.js";
import type { AppManifest } from "../../src/core/app-registry/types.js";

/**
 * P6-F (D6): scaffold E2E against a sealed mkdtemp fixture root — no DB, no server,
 * no writes outside the temp dir.
 *
 * The fixture root contains only what runCreateApp reads: apps/_template/ (copied from
 * the real repo template) plus empty backend/src/apps and frontend/src/apps skeletons.
 * It deliberately has NO package.json: runCreateApp's generate step is
 * execFileSync("npm", ["run", "generate:apps"], { cwd: root }), which would fail loudly
 * in this root — so a successful run with runGenerate: false proves no external command
 * was spawned.
 *
 * import.meta.dirname is <repo>/backend/test/unit (same style as isolation.test.ts), so
 * the repo root is three levels up. The real template and the real generated registry
 * tables are read from there and compared before/after — never written.
 */
const repoRoot = join(import.meta.dirname, "..", "..", "..");
const repoTemplateDir = join(repoRoot, "apps", "_template");

// Sealed-repo snapshot, taken before any test runs; re-checked in the final test.
const registrySnapshot = {
  backend: readFileSync(join(repoRoot, "backend", "src", "generated", "apps.ts"), "utf8"),
  frontend: readFileSync(join(repoRoot, "frontend", "src", "generated", "apps.ts"), "utf8"),
};

function makeFixtureRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "pp-create-app-"));
  mkdirSync(join(root, "apps", "_template"), { recursive: true });
  copyFileSync(join(repoTemplateDir, "app.yaml"), join(root, "apps", "_template", "app.yaml"));
  copyFileSync(join(repoTemplateDir, "README.md"), join(root, "apps", "_template", "README.md"));
  mkdirSync(join(root, "backend", "src", "apps"), { recursive: true });
  mkdirSync(join(root, "frontend", "src", "apps"), { recursive: true });
  // No package.json here — see the header comment.
  return root;
}

/** Run the body with a private fixture root; always clean it up. */
async function withFixtureRoot(fn: (root: string) => void | Promise<void>): Promise<void> {
  const root = makeFixtureRoot();
  try {
    await fn(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

/** runCreateApp prints "created app" banners; keep them out of the test output. */
function quiet<T>(fn: () => T): T {
  const original = console.log;
  console.log = () => {};
  try {
    return fn();
  } finally {
    console.log = original;
  }
}

function readFixtureFile(root: string, ...path: string[]): string {
  return readFileSync(join(root, ...path), "utf8");
}

/** Parse and validate apps/<id>/app.yaml; fail the test if it is not manifest-valid. */
function loadValidManifest(root: string, id: string): AppManifest {
  const validation = validateManifest(parse(readFixtureFile(root, "apps", id, "app.yaml")));
  if (!validation.ok) {
    assert.fail(`generated manifest for "${id}" is invalid: ${validation.errors.join("; ")}`);
  }
  const semantic = semanticErrors(validation.manifest);
  if (semantic.length > 0) {
    assert.fail(`generated manifest for "${id}" has semantic errors: ${semantic.join("; ")}`);
  }
  return validation.manifest;
}

function expectCreateAppError(call: () => void, ...messageParts: string[]): void {
  assert.throws(
    call,
    (err: unknown): boolean => {
      if (!(err instanceof CreateAppError)) return false;
      return messageParts.every((part) => err.message.includes(part));
    },
    "expected a CreateAppError whose message contains all expected parts",
  );
}

describe("runCreateApp (mkdtemp fixture root, D6)", () => {
  it("success path: substituted manifest, README, migrations dir, backend and frontend stubs", async () => {
    await withFixtureRoot((root) => {
      quiet(() => runCreateApp({ root, id: "demo", name: "Demo", runGenerate: false }));

      // apps/demo/app.yaml — placeholders substituted, manifest-valid.
      const yamlText = readFixtureFile(root, "apps", "demo", "app.yaml");
      assert.ok(!yamlText.includes("new_app"), "app.yaml still contains the new_app placeholder");
      assert.ok(!yamlText.includes("New App"), "app.yaml still contains the New App placeholder");
      const manifest = loadValidManifest(root, "demo");
      assert.equal(manifest.id, "demo");
      assert.equal(manifest.name, "Demo");

      // apps/demo/README.md — substituted.
      const readme = readFixtureFile(root, "apps", "demo", "README.md");
      assert.ok(readme.startsWith("# Demo"), `README title not substituted: ${readme.slice(0, 40)}`);
      assert.ok(!readme.includes("new_app"), "README still contains the new_app placeholder");
      assert.ok(!readme.includes("New App"), "README still contains the New App placeholder");

      // apps/demo/migrations/ exists as a directory (forward-only migration slot).
      assert.ok(
        statSync(join(root, "apps", "demo", "migrations")).isDirectory(),
        "apps/demo/migrations must be a directory",
      );

      // Backend stub: id constant and the contract-guaranteed /ping route.
      const backendSource = readFixtureFile(root, "backend", "src", "apps", "demo", "index.ts");
      assert.match(backendSource, /const id = "demo"/);
      assert.match(backendSource, /ctx\.api\.get\("\/ping"/);

      // Frontend stub: structure and zero syntax diagnostics via ts.transpileModule.
      const frontendPath = join(root, "frontend", "src", "apps", "demo", "index.tsx");
      const frontendSource = readFileSync(frontendPath, "utf8");
      assert.match(frontendSource, /id: "demo"/);
      assert.match(frontendSource, /const app: FrontendAppModule/);
      assert.match(frontendSource, /routes: \[\{ path: ""/);
      const transpiled = ts.transpileModule(frontendSource, {
        compilerOptions: {
          module: ts.ModuleKind.ESNext,
          target: ts.ScriptTarget.ES2022,
          jsx: ts.JsxEmit.ReactJSX,
        },
        fileName: frontendPath,
        reportDiagnostics: true,
      });
      assert.deepEqual(
        transpiled.diagnostics ?? [],
        [],
        "expected zero transpile diagnostics for the generated frontend stub",
      );
      assert.ok(transpiled.outputText.includes("_jsx("), "JSX was not actually compiled");
    });
  });

  it("runGenerate: false spawns no external command (fixture root has no package.json)", async () => {
    await withFixtureRoot((root) => {
      // If the execFileSync("npm", ["run", "generate:apps"], { cwd: root }) branch ran,
      // npm would fail against the missing package.json and runCreateApp would throw.
      assert.doesNotThrow(() => quiet(() => runCreateApp({ root, id: "nogen", runGenerate: false })));
      assert.ok(existsSync(join(root, "apps", "nogen", "app.yaml")), "scaffold files were not written");
    });
  });

  it("duplicate id fails, listing the already-existing paths", async () => {
    await withFixtureRoot((root) => {
      quiet(() => runCreateApp({ root, id: "demo", runGenerate: false }));
      expectCreateAppError(
        () => quiet(() => runCreateApp({ root, id: "demo", runGenerate: false })),
        join(root, "apps", "demo"),
        join(root, "backend", "src", "apps", "demo"),
        join(root, "frontend", "src", "apps", "demo"),
      );
    });
  });

  it('reserved id "core" is rejected before any write', async () => {
    await withFixtureRoot((root) => {
      expectCreateAppError(() => quiet(() => runCreateApp({ root, id: "core" })), "reserved");
      assert.ok(!existsSync(join(root, "apps", "core")), "nothing must be written for a rejected id");
    });
  });

  it('invalid id "Bad-ID" is rejected with the pattern message', async () => {
    await withFixtureRoot((root) => {
      expectCreateAppError(
        () => quiet(() => runCreateApp({ root, id: "Bad-ID", runGenerate: false })),
        "must match",
      );
      assert.ok(!existsSync(join(root, "apps", "Bad-ID")), "nothing must be written for a rejected id");
    });
  });

  it("pre-existing backend app dir is reported and no files are written", async () => {
    await withFixtureRoot((root) => {
      mkdirSync(join(root, "backend", "src", "apps", "zz"));
      expectCreateAppError(
        () => quiet(() => runCreateApp({ root, id: "zz", runGenerate: false })),
        join(root, "backend", "src", "apps", "zz"),
      );
      // All validation happens before the first write: neither sibling target exists.
      assert.ok(!existsSync(join(root, "apps", "zz")), "apps/zz must not be created");
      assert.ok(!existsSync(join(root, "frontend", "src", "apps", "zz")), "frontend zz must not be created");
    });
  });

  it('whitespace-only name "   " is rejected before any write', async () => {
    await withFixtureRoot((root) => {
      expectCreateAppError(
        () => quiet(() => runCreateApp({ root, id: "blank", name: "   ", runGenerate: false })),
        "must not be empty",
      );
      assert.ok(!existsSync(join(root, "apps", "blank")), "nothing must be written for a rejected name");
    });
  });

  it("omitting name defaults to the capitalized id in manifest and page title", async () => {
    await withFixtureRoot((root) => {
      quiet(() => runCreateApp({ root, id: "demo", runGenerate: false }));
      const manifest = loadValidManifest(root, "demo");
      assert.equal(manifest.name, "Demo");
      const frontendSource = readFixtureFile(root, "frontend", "src", "apps", "demo", "index.tsx");
      assert.match(frontendSource, /<h1 className="page-header__title">Demo<\/h1>/);
      assert.match(frontendSource, /label: "Demo"/);
    });
  });

  it("leaves the real repo registry tables untouched (sealed fixture)", () => {
    assert.equal(
      readFileSync(join(repoRoot, "backend", "src", "generated", "apps.ts"), "utf8"),
      registrySnapshot.backend,
      "backend/src/generated/apps.ts changed during the tests",
    );
    assert.equal(
      readFileSync(join(repoRoot, "frontend", "src", "generated", "apps.ts"), "utf8"),
      registrySnapshot.frontend,
      "frontend/src/generated/apps.ts changed during the tests",
    );
  });
});
