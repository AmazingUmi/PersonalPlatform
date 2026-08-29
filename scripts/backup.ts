#!/usr/bin/env tsx
/**
 * Personal Platform backup & restore (FP-11).
 *
 *   tsx scripts/backup.ts create  [--root DIR] [--database URL] [--output DIR]
 *   tsx scripts/backup.ts restore <backupDir> --yes [--root DIR] [--database URL]
 *
 * A backup directory contains:
 *   metadata.json     format version, timestamps, platform version, app list
 *   database.sql      pg_dump plain SQL (--no-owner --no-privileges)
 *   storage.tar.gz    the whole storage/ tree (attachments etc.)
 *   config/           config/ tree (platform.yaml, per-app yaml; no secrets)
 *
 * Secrets (.env), node_modules and build output are never included: only the
 * trees above are copied. RESTORE OVERWRITES the current database schemas,
 * storage/ and config/ — it refuses to run without --yes.
 */
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const DEFAULT_DATABASE_URL =
  process.env.DATABASE_URL ??
  "postgresql://personal_platform:change-me-for-local-development@localhost:5432/personal_platform";

const FORMAT_VERSION = 1;

interface Args {
  command: string;
  backupDir?: string;
  root: string;
  database: string;
  output: string;
  yes: boolean;
}

function usage(what = ""): never {
  if (what) console.error(`error: ${what}`);
  console.error(
    "usage:\n" +
      "  tsx scripts/backup.ts create [--root DIR] [--database URL] [--output DIR]\n" +
      "  tsx scripts/backup.ts restore <backupDir> --yes [--root DIR] [--database URL]",
  );
  process.exit(what ? 2 : 0);
}

function parseArgs(argv: string[]): Args {
  let root = process.cwd();
  let database = DEFAULT_DATABASE_URL;
  let output = "";
  let yes = false;
  let backupDir: string | undefined;
  let command = "";

  const positional: string[] = [];
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]!;
    if (arg === "--root") root = argv[++i] ?? usage("--root needs a value");
    else if (arg === "--database") database = argv[++i] ?? usage("--database needs a value");
    else if (arg === "--output") output = argv[++i] ?? usage("--output needs a value");
    else if (arg === "--yes") yes = true;
    else positional.push(arg);
  }

  command = positional[0] ?? "";
  if (command === "restore") {
    backupDir = positional[1];
    if (!backupDir) usage("restore needs a backup directory");
  } else if (command !== "create") {
    usage(`unknown command '${command}'`);
  }

  // Walk up from --root/cwd to the platform root (config/platform.yaml + apps/).
  let dir = resolve(root);
  for (let i = 0; i < 64; i += 1) {
    if (existsSync(join(dir, "config", "platform.yaml")) && existsSync(join(dir, "apps"))) break;
    const parent = join(dir, "..");
    if (parent === dir) usage("could not locate platform root (config/platform.yaml and apps/)");
    dir = parent;
  }

  return {
    command,
    backupDir,
    root: dir,
    database,
    output: resolve(output || join(dir, "backups")),
    yes,
  };
}

function run(command: string, args: string[], what: string): string {
  const result = spawnSync(command, args, { encoding: "utf8" });
  if (result.error) {
    console.error(`error: ${what}: cannot run '${command}' (${result.error.message})`);
    process.exit(1);
  }
  if (result.status !== 0) {
    console.error(`error: ${what}: '${command} ${args.join(" ")}' failed with exit ${result.status}`);
    if (result.stderr) console.error(result.stderr.trim());
    process.exit(1);
  }
  return result.stdout;
}

function platformVersion(root: string): string {
  try {
    const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as { version?: string };
    return pkg.version ?? "0.0.0";
  } catch {
    return "0.0.0";
  }
}

function installedApps(root: string): string[] {
  const appsDir = join(root, "apps");
  if (!existsSync(appsDir)) return [];
  return readdirSync(appsDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && existsSync(join(appsDir, entry.name, "app.yaml")))
    .map((entry) => entry.name)
    .sort();
}

function timestamp(): string {
  const now = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  return (
    `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}` +
    `_${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`
  );
}

function createBackup(args: Args): void {
  const dir = join(args.output, `personal_platform_${timestamp()}`);
  mkdirSync(dir, { recursive: true });

  const databaseFile = join(dir, "database.sql");
  run(
    "pg_dump",
    [args.database, "--no-owner", "--no-privileges", "--no-password", "--encoding=UTF8", `--file=${databaseFile}`],
    "database dump failed",
  );

  run(
    "tar",
    ["-czf", join(dir, "storage.tar.gz"), "--exclude", ".DS_Store", "-C", args.root, "storage"],
    "storage archive failed",
  );

  cpSync(join(args.root, "config"), join(dir, "config"), { recursive: true });

  // Metadata is written last: an aborted backup has no metadata.json and is
  // rejected by restore.
  const url = new URL(args.database.replace(/^postgres(ql)?:\/\//, "http://"));
  const metadata = {
    formatVersion: FORMAT_VERSION,
    createdAt: new Date().toISOString(),
    platformVersion: platformVersion(args.root),
    database: url.pathname.replace(/^\//, "") || "unknown",
    apps: installedApps(args.root),
    contents: { database: "database.sql", storage: "storage.tar.gz", config: "config/" },
  };
  writeFileSync(join(dir, "metadata.json"), `${JSON.stringify(metadata, null, 2)}\n`);

  console.log(`backup written to ${dir}`);
}

/** Never drop system schemas, no matter what the dump claims to create. */
function isDroppableSchema(name: string): boolean {
  return !name.startsWith("pg_") && name !== "information_schema";
}

function restoreBackup(args: Args): void {
  const dir = resolve(args.backupDir!);

  const metadataFile = join(dir, "metadata.json");
  if (!existsSync(metadataFile)) {
    console.error(`error: ${dir} is not a backup: metadata.json is missing`);
    process.exit(2);
  }
  let metadata: { formatVersion?: number; createdAt?: string };
  try {
    metadata = JSON.parse(readFileSync(metadataFile, "utf8"));
  } catch (error) {
    console.error(`error: metadata.json is not valid JSON: ${(error as Error).message}`);
    process.exit(2);
  }
  if (metadata.formatVersion !== FORMAT_VERSION) {
    console.error(
      `error: backup format version ${String(metadata.formatVersion)} is not supported ` +
        `(this tool writes/expects ${FORMAT_VERSION}); created at ${metadata.createdAt ?? "unknown"}`,
    );
    process.exit(2);
  }

  const databaseFile = join(dir, "database.sql");
  const storageFile = join(dir, "storage.tar.gz");
  for (const file of [databaseFile, storageFile]) {
    if (!existsSync(file)) {
      console.error(`error: backup is incomplete: ${file} is missing`);
      process.exit(2);
    }
  }

  if (!args.yes) {
    console.error(
      "refusing to restore: this OVERWRITES the current database schemas, storage/ and config/.\n" +
        "Re-run with --yes once you are sure (see README 'Backup & restore').",
    );
    process.exit(3);
  }

  // 1. Drop the schemas the dump recreates (platform schemas only), then load
  //    the dump in ONE transaction: a failure rolls back and leaves the
  //    database exactly as it was.
  const dump = readFileSync(databaseFile, "utf8");
  const schemas = [...new Set([...dump.matchAll(/^CREATE SCHEMA (?:IF NOT EXISTS )?"?([a-z_][a-z0-9_]*)"?\;/gim)].map((m) => m[1]!))]
    .filter(isDroppableSchema);
  if (schemas.length > 0) {
    const dropSql = schemas.map((schema) => `DROP SCHEMA IF EXISTS "${schema}" CASCADE;`).join("\n");
    run("psql", [args.database, "--no-password", "-v", "ON_ERROR_STOP=1", "-c", dropSql], "schema drop failed");
    console.log(`dropped schemas: ${schemas.join(", ")}`);
  }
  run(
    "psql",
    [args.database, "--no-password", "-v", "ON_ERROR_STOP=1", "--single-transaction", "-f", databaseFile],
    "database restore failed (rolled back; database unchanged)",
  );

  // 2. Storage: extract to a temp dir first, then swap, so a broken archive
  //    never destroys the current files.
  const staging = mkdtempSync(join(tmpdir(), "pp-restore-"));
  try {
    run("tar", ["-xzf", storageFile, "-C", staging], "storage extract failed");
    if (!existsSync(join(staging, "storage"))) {
      console.error("error: backup storage archive has no storage/ root");
      process.exit(2);
    }
    rmSync(join(args.root, "storage"), { recursive: true, force: true });
    cpSync(join(staging, "storage"), join(args.root, "storage"), { recursive: true });
  } finally {
    rmSync(staging, { recursive: true, force: true });
  }

  // 3. Config files ride along with the backup.
  const backupConfig = join(dir, "config");
  if (existsSync(backupConfig)) {
    cpSync(backupConfig, join(args.root, "config"), { recursive: true });
  }

  console.log(`restored backup ${dir} (created ${metadata.createdAt}) into ${args.root}`);
}

const args = parseArgs(process.argv.slice(2));
if (args.command === "create") createBackup(args);
else restoreBackup(args);
