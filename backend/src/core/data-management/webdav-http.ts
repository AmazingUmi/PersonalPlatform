import { lookup } from "node:dns/promises";
import http from "node:http";
import https from "node:https";
import { isIP } from "node:net";
import { AppError } from "../api/errors.js";

export const DAV_MAX_BYTES = 32 * 1024 * 1024;

export function allowedOrigins(): Set<string> {
  return new Set((process.env.DATA_BACKUP_ALLOWED_ORIGINS ?? "").split(",").map(s => s.trim()).filter(Boolean));
}

export function normalizeEndpoint(value: string): string {
  let url: URL;
  try { url = new URL(value); } catch { throw new AppError(422, "invalid_webdav_url", "Enter a valid WebDAV directory URL."); }
  if (url.username || url.password || url.search || url.hash || !["http:", "https:"].includes(url.protocol)) {
    throw new AppError(422, "invalid_webdav_url", "WebDAV URL must not contain credentials, a query or a fragment.");
  }
  if (url.protocol !== "https:" && !allowedOrigins().has(url.origin)) {
    throw new AppError(422, "webdav_origin_blocked", "WebDAV requires HTTPS. An operator must explicitly allow an internal HTTP origin.");
  }
  // Prevent encoded separators or dot traversal from changing the configured collection.
  if (/%(?:2f|5c|2e)|\\/i.test(url.pathname)) throw new AppError(422, "invalid_webdav_url", "WebDAV directory contains unsafe path encoding.");
  if (!url.pathname.endsWith("/")) url.pathname += "/";
  return url.href;
}

/** Fail closed: public global unicast only, including IPv4-mapped IPv6 handling. */
export function publicAddress(address: string): boolean {
  const lower = address.toLowerCase();
  if (lower.startsWith("::ffff:")) {
    const tail = lower.slice(7);
    if (isIP(tail) === 4) return publicAddress(tail);
    const parts = tail.split(":");
    if (parts.length !== 2) return false;
    const a = parseInt(parts[0]!, 16), b = parseInt(parts[1]!, 16);
    return publicAddress(`${a >> 8}.${a & 255}.${b >> 8}.${b & 255}`);
  }
  if (isIP(address) === 6) return /^[23][0-9a-f]{3}:/.test(lower) && !lower.startsWith("2001:db8:") && !lower.startsWith("2002:") && !lower.startsWith("2001:0:");
  if (isIP(address) !== 4) return false;
  const [a, b, c] = address.split(".").map(Number) as [number, number, number, number];
  return !(a === 0 || a === 10 || a === 127 || a >= 224 || (a === 100 && b >= 64 && b <= 127)
    || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31)
    || (a === 192 && (b === 168 || (b === 0 && (c === 0 || c === 2))))
    || (a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100))) || (a === 203 && b === 0 && c === 113));
}

/** Check every DNS answer before pinning a socket; an exception is origin-specific. */
export function validateResolvedDestination(origin: string, addresses: { address: string; family: number }[]): void {
  if (!addresses.length) throw new AppError(502, "webdav_unreachable", "WebDAV host returned no DNS addresses.");
  if (!allowedOrigins().has(origin) && addresses.some(({ address }) => !publicAddress(address))) {
    const resolved = addresses.slice(0, 8).map(({ address }) => address).join(", ");
    throw new AppError(422, "webdav_origin_blocked", `WebDAV server DNS resolved ${origin} to a private or reserved address (${resolved}). A proxy using Fake-IP DNS can cause this for a public service. Check the server's DNS/proxy, or have the operator add the trusted exact origin ${origin} to DATA_BACKUP_ALLOWED_ORIGINS. This request was blocked before authentication.`);
  }
}

export interface DavRequest {
  endpoint: string;
  username: string;
  password: string;
  method: "PROPFIND" | "PUT" | "GET" | "HEAD";
  filename?: string;
  body?: Buffer;
  timeoutMs?: number;
  /** Strong or server-supplied tag. When set on PUT, If-None-Match is not sent. */
  ifMatch?: string;
  /** Sent on GET. A 304 is success only when this is set. */
  ifNoneMatch?: string;
}

export interface DavResult {
  body: Buffer;
  status: number;
  etag?: string;
  length?: number;
}

export async function resolveWithTimeout(
  host: string,
  timeoutMs: number,
  resolver: (host: string) => Promise<{ address: string; family: number }[]> = host => lookup(host, { all: true }),
) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      resolver(host),
      new Promise<never>((_resolve, reject) => { timer = setTimeout(() => reject(new Error("DNS timeout")), timeoutMs); }),
    ]);
  } catch {
    throw new AppError(502, "webdav_unreachable", "WebDAV host could not be resolved.");
  } finally { if (timer) clearTimeout(timer); }
}

/** DNS is checked once then pinned on the socket; redirects are never followed. */
export async function davRequest(input: DavRequest): Promise<Buffer> {
  return (await davTransfer(input)).body;
}

export async function davExchange(input: DavRequest): Promise<DavResult> {
  return davTransfer(input);
}

export async function davHead(input: DavRequest): Promise<number | null> {
  const response = await davTransfer({ ...input, method: "HEAD", body: undefined });
  if (response.status === 404) return null;
  if (response.length === undefined) throw new AppError(502, "webdav_head_unsupported", "WebDAV HEAD must return a valid Content-Length. Use a full backup if this server does not support it.");
  return response.length;
}

async function davTransfer(input: DavRequest): Promise<DavResult> {
  const endpoint = normalizeEndpoint(input.endpoint);
  if (input.filename && !/^(?:ppm?-[a-f0-9-]+-(?:own|all)-[a-f0-9-]+\.json|ppc-[a-f0-9]{64}-[a-f0-9]{64}\.(?:json|bin)|pps-probe-[a-f0-9]{32}\.json|pps-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}-(?:head|[a-f0-9]{64})\.(?:json|bin))$/.test(input.filename)) {
    throw new AppError(422, "invalid_backup_name", "Invalid backup filename.");
  }
  const url = new URL(input.filename ?? "", endpoint);
  const host = url.hostname.replace(/^\[|\]$/g, "");
  const timeoutMs = input.timeoutMs ?? 30_000;
  const started = Date.now();
  const addresses = await resolveWithTimeout(host, timeoutMs);
  validateResolvedDestination(url.origin, addresses);
  const pinned = addresses[0]!;
  return new Promise((resolve, reject) => {
    const request = (url.protocol === "https:" ? https : http).request(url, {
      method: input.method,
      agent: false,
      family: pinned.family,
      lookup: (_hostname, _options, callback) => callback(null, pinned.address, pinned.family),
      headers: {
        authorization: `Basic ${Buffer.from(`${input.username}:${input.password}`).toString("base64")}`,
        ...(input.method === "PROPFIND" ? { depth: "0", "content-type": "application/xml" } : {}),
        ...(input.method === "GET" && input.ifNoneMatch ? { "if-none-match": input.ifNoneMatch } : {}),
        ...(input.method === "PUT" ? {
          "content-type": input.filename?.endsWith(".bin") ? "application/octet-stream" : "application/json",
          "content-length": input.body?.length ?? 0,
          ...(input.ifMatch ? { "if-match": input.ifMatch } : { "if-none-match": "*" }),
        } : {}),
      },
    });
    const timer = setTimeout(() => request.destroy(new Error("timeout")), Math.max(1, timeoutMs - (Date.now() - started)));
    let finished = false;
    const fail = (error: AppError) => { if (!finished) { finished = true; clearTimeout(timer); reject(error); } };
    request.on("error", () => fail(new AppError(502, "webdav_unreachable", "WebDAV request failed or timed out. Check the address, TLS certificate and connection.")));
    request.on("response", response => {
      const status = response.statusCode ?? 0;
      const notModified = input.method === "GET" && status === 304 && Boolean(input.ifNoneMatch);
      const ok = notModified || (input.method === "PROPFIND" ? status === 207 : input.method === "PUT" ? [200,201,204].includes(status) : input.method === "HEAD" ? [200,404].includes(status) : status === 200);
      if (!ok) {
        const hint = status === 401 ? "Check the account and WebDAV application password (some providers require an app password instead of the login password)."
          : status === 403 ? "The server denied access. Check this account's WebDAV and directory permissions."
          : status === 404 ? "The directory or backup was not found. Check the WebDAV URL and existing folder."
          : status === 405 ? "The server does not allow this WebDAV method. Check that the URL is a WebDAV endpoint."
          : status === 429 ? "The service is rate limiting requests. Wait before trying again."
          : status >= 300 && status < 400 ? "Redirects are not followed. Enter the final WebDAV directory URL."
          : "Check the service, directory and permissions.";
        fail(new AppError(502, "webdav_failed", `WebDAV returned HTTP ${status}. ${hint}`, { status }));
        response.destroy(); return;
      }
      let size = 0;
      const chunks: Buffer[] = [];
      response.on("data", (chunk: Buffer) => {
        size += chunk.length;
        const limit = input.method === "GET" ? DAV_MAX_BYTES : 64 * 1024;
        if (size > limit) { fail(new AppError(413, "backup_too_large", "WebDAV response exceeds the allowed size.")); response.destroy(); }
        else chunks.push(chunk);
      });
      response.on("error", () => fail(new AppError(502, "webdav_unreachable", "WebDAV download was interrupted.")));
      response.on("end", () => {
        if (!finished) {
          finished = true; clearTimeout(timer);
          const rawLength = response.headers["content-length"];
          const length = typeof rawLength === "string" && /^\d+$/.test(rawLength) && Number.isSafeInteger(Number(rawLength)) ? Number(rawLength) : undefined;
          const rawEtag = response.headers.etag;
          const etag = typeof rawEtag === "string" ? rawEtag : Array.isArray(rawEtag) ? rawEtag[0] : undefined;
          resolve({ body: Buffer.concat(chunks), status, length, ...(etag ? { etag } : {}) });
        }
      });
    });
    request.end(input.method === "PROPFIND" ? '<?xml version="1.0"?><d:propfind xmlns:d="DAV:"><d:prop><d:resourcetype/></d:prop></d:propfind>' : input.body);
  });
}
