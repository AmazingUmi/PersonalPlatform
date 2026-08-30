/**
 * Scaffold a new app from the developer template.
 *
 *   npm run create:app -- assets "Asset Manager"
 *
 * Generates apps/<id>/ (manifest, README, migrations), backend/src/apps/<id>/index.ts,
 * frontend/src/apps/<id>/index.tsx, then regenerates the compile-time module tables.
 *
 * The reusable entry point is runCreateApp({ root, id, name?, runGenerate? }): it validates
 * everything up front, throws CreateAppError on invalid input, and never touches
 * process.argv / process.exit, so it can be imported (and tested) without side effects.
 * The CLI wrapper at the bottom only activates when this file is the process entry point.
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

export class CreateAppError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CreateAppError";
  }
}

export interface CreateAppOptions {
  /** Repository root (the directory containing apps/, backend/, frontend/). */
  root: string;
  /** App id; must match ^[a-z][a-z0-9_]*$ and must not be the reserved id "core". */
  id: string;
  /** Display name; defaults to the capitalized id. Trimmed; must be non-empty. */
  name?: string;
  /** Run `npm run generate:apps` after writing files (default true). */
  runGenerate?: boolean;
}

const ID_PATTERN = /^[a-z][a-z0-9_]*$/;
const RESERVED_IDS = new Set(["core"]);

function toComponentName(id: string): string {
  return id.charAt(0).toUpperCase() + id.slice(1).replace(/_(.)/g, (_, c: string) => c.toUpperCase());
}

export function runCreateApp(options: CreateAppOptions): void {
  const { root, id } = options;

  // ---- validation: everything happens before the first write ----
  if (!ID_PATTERN.test(id)) {
    throw new CreateAppError(`invalid app_id "${id}": must match ^[a-z][a-z0-9_]*$`);
  }
  if (RESERVED_IDS.has(id)) {
    throw new CreateAppError(`app_id "core" is reserved: it collides with the core DB schema`);
  }
  const targetDirs: [string, string, string] = [
    join(root, "apps", id),
    join(root, "backend", "src", "apps", id),
    join(root, "frontend", "src", "apps", id),
  ];
  const existingDirs = targetDirs.filter((dir) => existsSync(dir));
  if (existingDirs.length > 0) {
    throw new CreateAppError(`app already exists:\n  ${existingDirs.join("\n  ")}`);
  }
  const name = (options.name ?? id.replace(/^./, (c) => c.toUpperCase())).trim();
  if (name.length === 0) {
    throw new CreateAppError(`app name must not be empty (got "${options.name ?? ""}")`);
  }
  const titleCase = name.replace(/\b\w/g, (c) => c.toUpperCase());
  const componentName = toComponentName(id);

  // ---- generation ----
  const substitute = (content: string): string =>
    content.replaceAll("new_app", id).replaceAll("New App", name);

  // Manifest + README from the template directory.
  const templateDir = join(root, "apps", "_template");
  const [appDir, backendDir, frontendDir] = targetDirs;
  mkdirSync(join(appDir, "migrations"), { recursive: true });
  writeFileSync(join(appDir, "app.yaml"), substitute(readFileSync(join(templateDir, "app.yaml"), "utf8")));
  writeFileSync(join(appDir, "README.md"), substitute(readFileSync(join(templateDir, "README.md"), "utf8")));

  // Backend stub.
  mkdirSync(backendDir, { recursive: true });
  writeFileSync(
    join(backendDir, "index.ts"),
    `import type { AppContext, BackendAppModule } from "../../core/app-registry/types.js";

const id = "${id}";

async function registerApi(ctx: AppContext): Promise<void> {
  ctx.api.get("/ping", async () => ({ app: id, pong: true }));
}

const app: BackendAppModule = { id, registerApi };
export default app;
`,
  );

  // Frontend stub (aligned with the page/page-header convention).
  mkdirSync(frontendDir, { recursive: true });
  writeFileSync(
    join(frontendDir, "index.tsx"),
    `import type { FrontendAppModule } from "../../shared/appTypes";

function ${componentName}Page() {
  return (
    <div className="page" data-app="${id}">
      <header className="page-header">
        <h1 className="page-header__title">${titleCase}</h1>
      </header>
      <p className="muted">New app scaffold...</p>
    </div>
  );
}

const app: FrontendAppModule = {
  id: "${id}",
  routes: [{ path: "", label: "${name}", element: <${componentName}Page /> }],
};

export default app;
`,
  );

  if (options.runGenerate ?? true) {
    execFileSync("npm", ["run", "generate:apps"], { cwd: root, stdio: "inherit" });
    console.log(`created app "${id}" (npm run generate:apps already ran).`);
  } else {
    console.log(`created app "${id}".`);
  }
  console.log(`
Next steps:
  1. Edit apps/${id}/app.yaml (description, widgets, capabilities).
  2. Write the first forward-only migration in apps/${id}/migrations/
     (bare table names; the runner creates the ${id} schema), then: npm run migration:up
  3. Implement backend/src/apps/${id}/index.ts and frontend/src/apps/${id}/index.tsx
     (the scaffold serves GET /api/apps/${id}/ping already).
  4. OPTIONAL customization: icon/accent entries in frontend/src/shared/ui/appIcons.ts
     and a [data-app="${id}"] accent in frontend/src/styles/tokens.css. Without them
     the app falls back to the generic icon and the primary accent — nothing to edit
     to get a working app.
  5. Read doc/APP_DEVELOPMENT.md for the full checklist (short version:
     apps/_template/README.md). Focus is the Contract V1 reference app.
`);
}

// ---- CLI wrapper (only active when this file is the process entry point) ----

function usage(): never {
  console.error('usage: npm run create:app -- <app_id> ["App Name"]');
  console.error("  app_id must match ^[a-z][a-z0-9_]*$");
  process.exit(1);
}

function runCli(): void {
  const [idArg, nameArg] = process.argv.slice(2);
  if (!idArg) usage();
  try {
    runCreateApp({ root: process.cwd(), id: idArg, name: nameArg });
  } catch (error) {
    if (error instanceof CreateAppError) {
      console.error(error.message);
      process.exit(1);
    }
    throw error;
  }
}

const isDirectRun = (() => {
  if (!process.argv[1]) return false;
  try {
    return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
})();

if (isDirectRun) runCli();
