import { randomBytes } from "node:crypto";
import { AppError } from "../api/errors.js";
import { davExchange, type DavRequest } from "./webdav-http.js";

/** Quoted etagc of 1–128 visible ASCII bytes. No weak validator, spaces, quotes, or controls. */
const STRONG_ETAG = /^"[\x21\x23-\x7E]{1,128}"$/;

export function readStrongEtag(etag: string | undefined): string | null {
  if (!etag || etag.startsWith("W/") || !STRONG_ETAG.test(etag)) return null;
  return etag;
}

export function probeObjectName(): string {
  return `pps-probe-${randomBytes(16).toString("hex")}.json`;
}

/**
 * Prove create-if-absent and If-Match before sync is enabled.
 * The strong ETag is taken from GET. A PUT response does not have to carry one.
 */
export async function probeConditionalWrites(input: Omit<DavRequest, "method" | "filename" | "body" | "ifMatch" | "ifNoneMatch">): Promise<void> {
  const filename = probeObjectName();
  const created = Buffer.from("probe-a");
  const replaced = Buffer.from("probe-d");
  try {
    await davExchange({ ...input, method: "PUT", filename, body: created });
  } catch (error) {
    throw rejected(error, "create");
  }
  const first = await readBody(input, filename, "etag");
  if (!first.body.equals(created)) throw unsupported("create");
  await require412(input, filename, Buffer.from("probe-b"), undefined, "create-if-absent");
  if (!(await readBody(input, filename, "create-if-absent")).body.equals(created)) throw unsupported("create-if-absent");
  await require412(input, filename, Buffer.from("probe-c"), "\"not-the-etag\"", "wrong-if-match");
  if (!(await readBody(input, filename, "wrong-if-match")).body.equals(created)) throw unsupported("wrong-if-match");
  try {
    await davExchange({ ...input, method: "PUT", filename, body: replaced, ifMatch: first.etag });
  } catch (error) {
    throw rejected(error, "current-if-match");
  }
  const second = await readBody(input, filename, "current-if-match");
  if (!second.body.equals(replaced) || second.etag === first.etag) throw unsupported("current-if-match");
  await require412(input, filename, Buffer.from("probe-e"), first.etag, "stale-etag");
  if (!(await readBody(input, filename, "stale-etag")).body.equals(replaced)) throw unsupported("stale-etag");
}

async function readBody(input: Omit<DavRequest, "method" | "filename" | "body">, filename: string, step: string): Promise<{ body: Buffer; etag: string }> {
  for (let attempt = 0; attempt < 2; attempt++) {
    const response = await davExchange({ ...input, method: "GET", filename });
    const etag = readStrongEtag(response.etag);
    if (etag) return { body: response.body, etag };
  }
  throw unsupported(step);
}

async function require412(input: Omit<DavRequest, "method" | "filename" | "body" | "ifMatch">, filename: string, body: Buffer, ifMatch: string | undefined, step: string): Promise<void> {
  try {
    await davExchange({ ...input, method: "PUT", filename, body, ...(ifMatch ? { ifMatch } : {}) });
  } catch (error) {
    if (error instanceof AppError && statusOf(error) === 412) return;
    throw rejected(error, step);
  }
  throw unsupported(step);
}

function statusOf(error: AppError): number | undefined {
  return (error.details as { status?: number } | undefined)?.status;
}

function unsupported(step: string): AppError {
  return new AppError(422, "webdav_cas_unsupported", `WebDAV conditional writes failed at ${step}. Sync was not enabled.`, { step });
}

function rejected(error: unknown, step: string): AppError {
  if (error instanceof AppError) return error;
  return unsupported(step);
}
