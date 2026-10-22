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
import { cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { extractRestoreSchemas } from "./backup-schemas.js";

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
    throw new Error(`${what}: cannot run '${command}' (${result.error.message})`);
  }
  if (result.status !== 0) {
    // Arguments contain database credentials; never include them in logs.
    throw new Error(`${what}: '${command}' failed with exit ${result.status}\n${result.stderr?.trim() ?? ""}`);
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

function snapshotIfPresent(source: string, destination: string): void {
  try {
    const entry = lstatSync(source);
    if (!entry.isDirectory() || entry.isSymbolicLink()) {
      throw new Error(`restore target must be a real directory, not a symlink or file: ${source} (database not changed)`);
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  cpSync(source, destination, { recursive: true });
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

  // Preflight all incoming files and retain the old trees before touching DB.
  // A stopped backend/scheduler is required: DB and files have no shared tx.
  const dump = readFileSync(databaseFile, "utf8");
  const schemas = extractRestoreSchemas(dump);
  const staging = mkdtempSync(join(args.root, ".restore-stage-"));
  let preserveStaging = false;
  try {
    const incoming = join(staging, "incoming");
    mkdirSync(incoming);
    run("tar", ["-xzf", storageFile, "-C", incoming], "storage extract failed (database not changed)");
    const incomingStorage = join(incoming, "storage");
    if (!existsSync(incomingStorage) || !lstatSync(incomingStorage).isDirectory() || lstatSync(incomingStorage).isSymbolicLink()) {
      throw new Error("backup storage archive has no regular storage/ directory (database not changed)");
    }
    const backupConfig = join(dir, "config");
    if (!lstatSync(backupConfig).isDirectory() || !lstatSync(join(backupConfig, "platform.yaml")).isFile()) {
      throw new Error("backup config/platform.yaml is missing (database not changed)");
    }
    cpSync(backupConfig, join(incoming, "config"), { recursive: true });
    snapshotIfPresent(join(args.root, "storage"), join(staging, "previous-storage"));
    snapshotIfPresent(join(args.root, "config"), join(staging, "previous-config"));
    const stagedSql = join(staging, "database.sql");
    writeFileSync(stagedSql, dump);

    const dropSql = schemas.map((schema) => `DROP SCHEMA IF EXISTS "${schema}" CASCADE;`).join("\n");
    run("psql", [args.database, "--no-psqlrc", "--no-password", "-v", "ON_ERROR_STOP=1", "--single-transaction",
      ...(dropSql ? ["-c", dropSql] : []), "-f", stagedSql], "database restore failed; file installation not started");

    try {
      // Copy into the existing roots: a Docker volume's mountpoint cannot be
      // renamed. Its children may be replaced after the old tree is retained.
      for (const tree of ["storage", "config"]) {
        const destination = join(args.root, tree);
        mkdirSync(destination, { recursive: true });
        for (const entry of readdirSync(destination)) rmSync(join(destination, entry), { recursive: true, force: true });
        cpSync(join(incoming, tree), destination, { recursive: true });
      }
    } catch (error) {
      preserveStaging = true;
      throw new Error(`database restored (committed), file installation incomplete; old and incoming trees retained at ${staging}: ${(error as Error).message}`);
    }
  } finally {
    if (!preserveStaging) rmSync(staging, { recursive: true, force: true });
  }

  console.log(`restored backup ${dir} (created ${metadata.createdAt}) into ${args.root}`);
}

try {
  const args = parseArgs(process.argv.slice(2));
  if (args.command === "create") createBackup(args);
  else restoreBackup(args);
} catch (error) {
  console.error(`error: ${(error as Error).message}`);
  process.exitCode = 1;
}
