/**
 * Backend-side app contract validator (Phase 6 / D5, two-track validation).
 *
 * Track 1 (this script, tsx): reuses scan() from generate-apps-registry.ts and
 * the committed backend/src/generated/apps.ts to enforce, per valid manifest:
 *   - a manifest with hasBackend must have a backendAppModules[id] entry
 *   - backendAppModules[id].id must equal the manifest id
 *   - backendAppModules must contain nothing beyond those manifests (stale table)
 * Track 2 (frontend ids + widget drift) cannot run under tsx — the frontend
 * module table imports svg assets — and lives in
 * frontend/src/shell/app-contract.test.ts under vitest instead.
 *
 * Usage: npm run verify:apps
 */
import { backendAppModules } from "../backend/src/generated/apps.js";
import { scan } from "./generate-apps-registry.ts";

const root = process.cwd();
const apps = scan(root);

const problems: string[] = [];
const expectedBackendIds = new Set<string>();

for (const app of apps) {
  if (!app.hasBackend) continue;
  expectedBackendIds.add(app.id);
  const mod = backendAppModules[app.id];
  if (!mod) {
    problems.push(
      `app "${app.id}" has backend/src/apps/${app.id}/index.ts but is missing from backendAppModules (stale generated table? run npm run generate:apps)`,
    );
  } else if (mod.id !== app.id) {
    problems.push(`backendAppModules["${app.id}"].id is "${mod.id}", expected "${app.id}"`);
  }
}

for (const key of Object.keys(backendAppModules).sort()) {
  if (!expectedBackendIds.has(key)) {
    problems.push(
      `backendAppModules["${key}"] has no valid manifest with a backend module (stale generated table? run npm run generate:apps)`,
    );
  }
}

if (problems.length > 0) {
  console.error(`verify:apps: ${problems.length} problem(s):`);
  for (const problem of problems) console.error(`  - ${problem}`);
  process.exit(1);
}

console.log(`verify:apps: ${apps.length} app(s) consistent`);
