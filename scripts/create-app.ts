/**
 * Scaffold a new app from the developer template.
 *
 *   npm run create:app -- assets "Asset Manager"
 *
 * Generates apps/<id>/ (manifest, README, migrations), backend/src/apps/<id>/index.ts,
 * frontend/src/apps/<id>/index.tsx, then regenerates the compile-time module tables.
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const root = process.cwd();
const [idArg, nameArg] = process.argv.slice(2);

function usage(): never {
  console.error('usage: npm run create:app -- <app_id> ["App Name"]');
  console.error("  app_id must match ^[a-z][a-z0-9_]*$");
  process.exit(1);
}

const id = idArg ?? usage();
if (!/^[a-z][a-z0-9_]*$/.test(id)) {
  console.error(`invalid app_id "${id}": must match ^[a-z][a-z0-9_]*$`);
  process.exit(1);
}
const name = nameArg ?? id.replace(/^./, (c) => c.toUpperCase());
const titleCase = name.replace(/\b\w/g, (c) => c.toUpperCase());

function substitute(content: string): string {
  return content.replaceAll("new_app", id).replaceAll("New App", name);
}

const appDir = join(root, "apps", id);
if (existsSync(appDir)) {
  console.error(`app already exists: ${appDir}`);
  process.exit(1);
}

// Manifest + README from the template directory.
mkdirSync(join(appDir, "migrations"), { recursive: true });
const templateDir = join(root, "apps", "_template");
writeFileSync(join(appDir, "app.yaml"), substitute(readFileSync(join(templateDir, "app.yaml"), "utf8")));
writeFileSync(join(appDir, "README.md"), substitute(readFileSync(join(templateDir, "README.md"), "utf8")));

// Backend stub.
const backendDir = join(root, "backend", "src", "apps", id);
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

// Frontend stub.
const frontendDir = join(root, "frontend", "src", "apps", id);
mkdirSync(frontendDir, { recursive: true });
writeFileSync(
  join(frontendDir, "index.tsx"),
  `import type { FrontendAppModule } from "../../shared/appTypes";

function ${id.charAt(0).toUpperCase() + id.slice(1).replace(/_(.)/g, (_, c: string) => c.toUpperCase())}Page() {
  return (
    <div className="page">
      <h1>${titleCase}</h1>
      <p className="muted">New app scaffold.</p>
    </div>
  );
}

const app: FrontendAppModule = {
  id: "${id}",
  routes: [{ path: "", label: "${name}", element: <${id.charAt(0).toUpperCase() + id.slice(1).replace(/_(.)/g, (_, c: string) => c.toUpperCase())}Page /> }],
};

export default app;
`,
);

execFileSync("npm", ["run", "generate:apps"], { cwd: root, stdio: "inherit" });
console.log(`created app "${id}". Edit app.yaml, then implement backend/src/apps/${id}/index.ts.`);
