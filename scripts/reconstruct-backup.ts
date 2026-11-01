/** Rebuild a downloaded WebDAV manifest and content objects without a database. */
import { constants } from "node:fs";
import { lstat, open, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { parseManifest, reconstructManifest } from "../backend/src/core/data-management/incremental.js";
import { MAX_SNAPSHOT_BYTES } from "../backend/src/core/data-management/snapshot-schema.js";

async function readRegular(path: string): Promise<Buffer> {
  // Nonblocking open lets fstat reject FIFOs/devices before attempting a read.
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > MAX_SNAPSHOT_BYTES) throw new Error("Input must be a regular file within the 32 MiB limit.");
    const data = await handle.readFile();
    if (data.length > MAX_SNAPSHOT_BYTES) throw new Error("Input exceeds the 32 MiB limit.");
    return data;
  } finally { await handle.close(); }
}

async function main(): Promise<void> {
  const args = new Map<string, string>();
  for (let i = 2; i < process.argv.length; i += 2) {
    const name = process.argv[i], value = process.argv[i + 1];
    if (!name || !["--manifest", "--objects", "--output"].includes(name) || !value || args.has(name)) {
      throw new Error("Usage: reconstruct-backup.ts --manifest FILE --objects DIRECTORY --output FILE");
    }
    args.set(name, value);
  }
  if (args.size !== 3) throw new Error("All three explicit paths are required. No database or default storage is accessed.");
  const objects = resolve(args.get("--objects")!);
  const stat = await lstat(objects);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("Objects path must be a real directory, not a symlink.");
  const manifest = parseManifest(await readRegular(resolve(args.get("--manifest")!)));
  const snapshot = await reconstructManifest(manifest, ref => readRegular(join(objects, ref.filename)));
  await writeFile(resolve(args.get("--output")!), JSON.stringify(snapshot), { flag: "wx", mode: 0o600 });
  console.log("Full Settings JSON reconstructed. Existing output files are never overwritten.");
}

main().catch(error => { console.error(error instanceof Error ? error.message : "Reconstruction failed."); process.exitCode = 1; });
