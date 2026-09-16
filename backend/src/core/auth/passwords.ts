/**
 * Password hashing (AUTH-1). Argon2id via @node-rs/argon2 (prebuilt native
 * bindings, musl included for the alpine Docker images). Parameters follow
 * the OWASP baseline m=19 MiB, t=2, p=1 — the library defaults, stated
 * explicitly so a library-default change cannot silently weaken them.
 *
 * verifyPassword fails CLOSED: any error (malformed stored hash such as the
 * bootstrap placeholder, rejected input) means "invalid credentials", never
 * a 500 and never a success.
 */
import { hash, verify } from "@node-rs/argon2";

const ARGON2_OPTIONS = { memoryCost: 19_456, timeCost: 2, parallelism: 1 };

/** Minimum enforced everywhere a password is accepted (bootstrap, admin API). */
export const MIN_PASSWORD_LENGTH = 8;

export async function hashPassword(password: string): Promise<string> {
  return hash(password, ARGON2_OPTIONS);
}

export async function verifyPassword(passwordHash: string, password: string): Promise<boolean> {
  try {
    return await verify(passwordHash, password, ARGON2_OPTIONS);
  } catch {
    return false;
  }
}
