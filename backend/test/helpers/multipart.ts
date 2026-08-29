import { randomUUID } from "node:crypto";

export interface MultipartPart {
  name: string;
  filename?: string;
  contentType?: string;
  data: Buffer | string;
}

/**
 * Build a minimal multipart/form-data body for fastify inject, which cannot
 * serialize FormData objects itself.
 */
export function multipartBody(parts: MultipartPart[]): {
  payload: Buffer;
  headers: Record<string, string>;
} {
  const boundary = `----pp-test-${randomUUID()}`;
  const chunks: Buffer[] = [];
  for (const part of parts) {
    chunks.push(Buffer.from(`--${boundary}\r\n`));
    const disposition = `Content-Disposition: form-data; name="${part.name}"${part.filename ? `; filename="${part.filename}"` : ""}\r\n`;
    chunks.push(Buffer.from(disposition));
    if (part.contentType) chunks.push(Buffer.from(`Content-Type: ${part.contentType}\r\n`));
    chunks.push(Buffer.from("\r\n"));
    chunks.push(Buffer.isBuffer(part.data) ? part.data : Buffer.from(part.data));
    chunks.push(Buffer.from("\r\n"));
  }
  chunks.push(Buffer.from(`--${boundary}--\r\n`));
  return {
    payload: Buffer.concat(chunks),
    headers: { "content-type": `multipart/form-data; boundary=${boundary}` },
  };
}
