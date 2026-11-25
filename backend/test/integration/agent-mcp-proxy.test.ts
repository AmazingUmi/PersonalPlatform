import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { request as httpRequest } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import Fastify from "fastify";
import { registerAgentIngress } from "../../src/core/agent/transport.js";

test("Nginx forwards an Agent SSE frame before an admitted tool finishes", async (t) => {
  const version = spawnSync("nginx", ["-v"]);
  if (version.error && (version.error as NodeJS.ErrnoException).code === "ENOENT") {
    t.skip("Nginx executable is unavailable");
    return;
  }
  assert.equal(version.status, 0, version.stderr?.toString());

  const tmp = mkdtempSync(join(tmpdir(), "pp-agent-nginx-"));
  const socketPath = join(tmp, "proxy.sock");
  const app = Fastify();
  let release!: () => void;
  const wait = new Promise<void>((resolve) => { release = resolve; });
  let finished = false;
  registerAgentIngress(app, {
    async authenticate() { return { agentId: "fixture", tokenHash: "test" }; },
    async manifest() { throw new Error("Unexpected discovery"); },
    async resource() { throw new Error("Unexpected resource read"); },
    async invoke(_credential, _actor, _name, _args, admit) {
      admit?.();
      await wait;
      finished = true;
      return { ok: true, data: { fixture: "done" } };
    },
  }, { enabled: true, allowedOrigins: [] });
  t.after(async () => {
    release();
    await app.close();
    rmSync(tmp, { recursive: true, force: true });
  });

  const upstream = await app.listen({ host: "127.0.0.1", port: 0 });
  const originalConfig = readFileSync(resolve(import.meta.dirname, "../../../docker/nginx.conf"), "utf8");
  const locationConfig = originalConfig
    .replace("listen 8080 default_server;", `listen unix:${socketPath};`)
    .replace("set $backend http://backend:8000;", `set $backend ${upstream};`);
  assert.notEqual(locationConfig, originalConfig);
  const configFile = join(tmp, "nginx.conf");
  writeFileSync(configFile, `error_log stderr; pid nginx.pid; events {} http { access_log off; ${locationConfig} }`);
  const nginx = spawn("nginx", ["-p", tmp, "-c", configFile, "-g", "daemon off; master_process off;"]);
  const stopped = once(nginx, "close");
  let errors = "";
  nginx.stderr.setEncoding("utf8").on("data", (chunk) => { errors += chunk; });
  t.after(async () => {
    if (nginx.exitCode === null) nginx.kill();
    await stopped;
  });
  for (let index = 0; index < 80 && !existsSync(socketPath) && nginx.exitCode === null; index++) await delay(25);
  assert.ok(existsSync(socketPath), errors);

  const body = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "fixture" } });
  const response = await new Promise<import("node:http").IncomingMessage>((resolve, reject) => {
    const request = httpRequest({
      socketPath, method: "POST", path: "/api/agent/mcp",
      headers: {
        Authorization: "Bearer " + Buffer.alloc(32, 97).toString("base64url"),
        "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body),
        "MCP-Protocol-Version": "2025-11-25", Accept: "application/json, text/event-stream",
      },
    }, resolve);
    request.on("error", reject);
    request.setTimeout(2000, () => request.destroy(new Error("Nginx withheld the first SSE frame")));
    request.end(body);
  });
  try {
    assert.equal(response.statusCode, 200, errors);
    assert.match(response.headers["content-type"] ?? "", /^text\/event-stream/);
    assert.equal(response.headers["cache-control"], "private, no-store");
    const stream = response[Symbol.asyncIterator]();
    const early = await stream.next();
    assert.equal(early.done, false);
    assert.match(early.value.toString(), /^:/);
    assert.equal(finished, false);
    release();
    let rest = "";
    for await (const chunk of stream) rest += chunk.toString();
    assert.match(rest, /"fixture":"done"/);
    assert.equal(finished, true);
  } finally {
    release();
    response.destroy();
  }
});
