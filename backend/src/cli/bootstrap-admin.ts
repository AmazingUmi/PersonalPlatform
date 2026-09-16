/**
 * Bootstrap admin CLI (AUTH-1):
 *   npm run bootstrap:admin -- --username <name>          # prompts for the password (hidden)
 *   BOOTSTRAP_ADMIN_PASSWORD=… npm run bootstrap:admin    # password from env
 *
 * Idempotent and non-destructive — an already-activated account is never
 * rewritten. Passwords are read hidden from stdin (or env) and never logged.
 */
import { stdin, stdout } from "node:process";
import { createLogger } from "../core/logging/index.js";
import { findRepoRoot } from "../core/config/index.js";
import { Database } from "../core/database/index.js";
import { runCoreMigrations } from "../core/database/startup-migrations.js";
import { ensureBootstrapAdmin } from "../core/auth/service.js";

const log = createLogger("warn");

function argValue(flag: string): string | undefined {
  const index = process.argv.indexOf(flag);
  return index >= 0 ? process.argv[index + 1]?.trim() || undefined : undefined;
}

async function readHidden(prompt: string): Promise<string> {
  // readline cannot hide typed input portably; read raw keystrokes with the
  // echo disabled instead (the classic hidden-password stdin dance).
  return new Promise((resolve, reject) => {
    const input = stdin;
    if (!input.isTTY) {
      reject(new Error("stdin is not a TTY; set BOOTSTRAP_ADMIN_PASSWORD instead"));
      return;
    }
    input.setRawMode(true);
    input.resume();
    input.setEncoding("utf8");
    stdout.write(prompt);
    let value = "";
    const onData = (chunk: string): void => {
      if (chunk === "\r" || chunk === "\n") {
        input.setRawMode(false);
        input.off("data", onData);
        stdout.write("\n");
        resolve(value);
        return;
      }
      if (chunk === "\u0003") {
        input.setRawMode(false);
        input.off("data", onData);
        reject(new Error("interrupted"));
        return;
      }
      if (chunk === "\u007f" || chunk === "\b") {
        value = value.slice(0, -1);
        return;
      }
      value += chunk;
    };
    input.on("data", onData);
  });
}

async function main(): Promise<void> {
  const username = argValue("--username") ?? "admin";
  const password = process.env.BOOTSTRAP_ADMIN_PASSWORD?.length
    ? process.env.BOOTSTRAP_ADMIN_PASSWORD
    : await readHidden("Password (hidden, min 8 chars): ");

  const databaseUrl =
    process.env.DATABASE_URL ??
    "postgresql://personal_platform:change-me-for-local-development@localhost:5432/personal_platform";
  const root = findRepoRoot();
  const database = new Database(databaseUrl, log);
  try {
    await database.connect();
    await runCoreMigrations({ databaseUrl, root, log });
    const outcome = await ensureBootstrapAdmin(database.context(), { username, password, log });
    switch (outcome.action) {
      case "activated":
        console.log(`bootstrap: activated admin "${outcome.username}" (placeholder account now has a password)`);
        break;
      case "created":
        console.log(`bootstrap: created admin "${outcome.username}"`);
        break;
      case "noop":
        if (outcome.reason === "already-active") {
          console.log(`bootstrap: admin "${outcome.username}" is already active — password left unchanged`);
        } else {
          console.error(`bootstrap: no changes (reason: ${outcome.reason})`);
          process.exitCode = 1;
        }
        break;
    }
  } finally {
    await database.close().catch(() => undefined);
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
