import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import {
  CallToolRequestSchema, ErrorCode, InitializeRequestSchema, JSONRPCRequestSchema,
  ListResourcesRequestSchema, ListToolsRequestSchema, McpError, ReadResourceRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { AppError } from "../api/errors.js";
import { USERNAME_PATTERN } from "../auth/service.js";
import type { AgentRuntimeConfig } from "../config/index.js";
import { agentDatastoreError } from "./errors.js";
import type { AgentCredential, AgentManifest, AgentResult } from "./types.js";

export interface AgentIngressGateway {
  authenticate(token: string): Promise<AgentCredential>;
  manifest(credential: AgentCredential, selector?: string): Promise<AgentManifest>;
  invoke(credential: AgentCredential, selector: string | undefined, name: string, args: unknown, onAdmitted?: () => void): Promise<AgentResult>;
  resource(credential: AgentCredential, selector: string | undefined, uri: string): Promise<{ uri: string; mimeType: string; text: string }>;
}

export type AgentIngressOptions = Pick<AgentRuntimeConfig, "enabled" | "allowedOrigins"> & { now?: () => Date };

const MCP_PATH = "/api/agent/mcp";
const VERSION = "2025-11-25";
const ACCEPT = "application/json, text/event-stream";
const BODY_LIMIT = 1024 * 1024;
const WINDOW_MS = 60_000;
const MAX_BUCKETS = 4096;

class SlidingWindow {
  private readonly buckets = new Map<string, number[]>();

  constructor(private readonly limit: number) {}

  take(key: string, now: number): boolean {
    const cutoff = now - WINDOW_MS;
    for (const [entry, hits] of this.buckets) {
      if (hits.at(-1)! > cutoff) break;
      this.buckets.delete(entry);
    }
    const current = this.buckets.get(key);
    if (!current && this.buckets.size >= MAX_BUCKETS) return false;
    const hits = current?.filter((time) => time > cutoff) ?? [];
    if (hits.length >= this.limit) return false;
    hits.push(now);
    this.buckets.delete(key);
    this.buckets.set(key, hits);
    return true;
  }
}

function object(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function headerValues(request: FastifyRequest, name: string): string[] {
  const raw = request.raw.rawHeaders;
  if (raw?.length) {
    const values: string[] = [];
    for (let index = 0; index < raw.length; index += 2) {
      if (raw[index]?.toLowerCase() === name) values.push(raw[index + 1]!);
    }
    return values;
  }
  const value = request.headers[name];
  return Array.isArray(value) ? value : value === undefined ? [] : [value];
}

function isMcp(request: FastifyRequest): boolean {
  return request.routeOptions.url === MCP_PATH;
}

function selector(request: FastifyRequest, alternate?: unknown): string | undefined {
  const headers = headerValues(request, "x-pp-acting-user");
  const value = headers[0] ?? alternate;
  if (headers.length > 1 || (headers.length && alternate !== undefined)
      || (value !== undefined && (typeof value !== "string" || !USERNAME_PATTERN.test(value)))) {
    throw new AppError(400, "invalid_acting_user", "Supply one valid acting-user selector.");
  }
  return value as string | undefined;
}

/** Called only after parsing succeeds, so each top-level colon has a JSON property name. */
function hasDuplicateBodySelector(body: string): boolean {
  let depth = 0;
  let count = 0;
  let lastString: string | undefined;
  for (const [token] of body.matchAll(/"(?:\\[\s\S]|[^"\\])*"|[{}\[\]:]/g)) {
    if (token === "{" || token === "[") depth++;
    else if (token === "}" || token === "]") depth--;
    else if (depth === 1) {
      if (token.startsWith('"')) lastString = token;
      else if (lastString !== undefined && JSON.parse(lastString) === "_actingUser" && ++count > 1) return true;
    }
  }
  return false;
}

function acceptsBoth(request: FastifyRequest): boolean {
  const mediaTypes = new Set<string>();
  for (const field of headerValues(request, "accept").flatMap((value) => value.split(","))) {
    const [type, ...parameters] = field.toLowerCase().split(";");
    const q = parameters.map((part) => part.trim()).find((part) => part.startsWith("q="));
    if (!q || (Number(q.slice(2)) > 0 && Number(q.slice(2)) <= 1)) mediaTypes.add(type!.trim());
  }
  return mediaTypes.has("application/json") && mediaTypes.has("text/event-stream");
}

function failure(reply: FastifyReply, request: FastifyRequest, error: AppError, rpcCode: number = -32000): FastifyReply {
  if (error.statusCode === 401) reply.header("WWW-Authenticate", 'Bearer realm="PersonalPlatform Agent"');
  const data = { code: error.code, ...(error.details === undefined ? {} : { details: error.details }) };
  if (isMcp(request)) {
    return reply.code(error.statusCode).send({ jsonrpc: "2.0", id: null, error: { code: rpcCode, message: error.message, data } });
  }
  return reply.code(error.statusCode).send({ ok: false, error: { ...data, message: error.message } });
}

const genericFailure = () => new AppError(500, "internal_error", "Agent request failed.");
const invalidRequest = () => new AppError(400, "invalid_request", "Send one valid JSON-RPC message.");
const asAppError = (error: unknown) => error instanceof AppError ? error : agentDatastoreError(error) ?? genericFailure();

function limited(reply: FastifyReply, request: FastifyRequest): FastifyReply {
  reply.header("Retry-After", String(WINDOW_MS / 1000));
  return failure(reply, request, new AppError(429, "rate_limited", "Too many Agent requests. Retry later."));
}

async function prepareTool(
  gateway: AgentIngressGateway, credential: AgentCredential, actor: string | undefined,
  params: { name: string; arguments?: Record<string, unknown> },
): Promise<{ result: Promise<AgentResult> } | { error: AppError }> {
  let admit!: () => void;
  const admitted = new Promise<"admitted">((resolve) => { admit = () => resolve("admitted"); });
  const result = gateway.invoke(credential, actor, params.name, params.arguments ?? {}, admit);
  const first = await Promise.race([admitted, result]);
  if (first !== "admitted" && !first.ok) {
    return { error: new AppError(first.status, first.error.code, first.error.message, first.error.details) };
  }
  return { result };
}

async function mcp(
  request: FastifyRequest, reply: FastifyReply, gateway: AgentIngressGateway, credential: AgentCredential,
) {
  const body = request.body;
  if (!object(body)) return failure(reply, request, invalidRequest(), ErrorCode.InvalidRequest);

  const versions = headerValues(request, "mcp-protocol-version");
  if (versions.length > 1 || (versions.length === 1 && versions[0] !== VERSION)
      || (versions.length === 0 && body.method !== "initialize")) {
    return failure(reply, request, new AppError(400, "unsupported_protocol_version", "Use MCP protocol version " + VERSION + "."));
  }
  const actor = selector(request);
  const tool = body.method === "tools/call" && JSONRPCRequestSchema.safeParse(body).success
    ? CallToolRequestSchema.safeParse(body)
    : undefined;
  // Task augmentation is unsupported. Let the SDK reject it before any tool runs.
  const execution = tool?.success && tool.data.params.task === undefined
    ? await prepareTool(gateway, credential, actor, tool.data.params)
    : undefined;
  if (execution && "error" in execution) return failure(reply, request, execution.error);
  // The invocation starts early for admission. Observe a rejected promise until
  // the SDK installs its response handler, without changing the returned result.
  if (execution) void execution.result.catch(() => undefined);

  const server = new Server({ name: "PersonalPlatform", version: "1.0.0" }, { capabilities: { tools: {}, resources: {} } });
  const transport = new WebStandardStreamableHTTPServerTransport({
    enableJsonResponse: execution === undefined,
    keepAliveMs: 100,
  });
  let beforeResponse: AppError | undefined;
  const access = async <T>(action: () => Promise<T>): Promise<T> => {
    try {
      return await action();
    } catch (error) {
      beforeResponse = asAppError(error);
      throw new McpError(ErrorCode.InternalError, "Agent request was rejected.");
    }
  };

  server.setRequestHandler(InitializeRequestSchema, async () => ({
    protocolVersion: VERSION, capabilities: { tools: {}, resources: {} },
    serverInfo: { name: "PersonalPlatform", version: "1.0.0" },
  }));
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: (await access(() => gateway.manifest(credential, actor))).tools,
  }));
  server.setRequestHandler(ListResourcesRequestSchema, async () => ({
    resources: (await access(() => gateway.manifest(credential, actor))).resources,
  }));
  server.setRequestHandler(ReadResourceRequestSchema, async ({ params }) => ({
    contents: [await access(() => gateway.resource(credential, actor, params.uri))],
  }));
  server.setRequestHandler(CallToolRequestSchema, async () => {
    if (!execution) throw new McpError(ErrorCode.InvalidParams, "Invalid tool request.");
    let result: AgentResult;
    try {
      result = await execution.result;
    } catch {
      result = { ok: false, status: 500, error: { code: "internal_error", message: "Agent tool failed." } };
    }
    return {
      ...(result.ok ? {} : { isError: true }),
      structuredContent: { ...result },
      content: [{ type: "text", text: JSON.stringify(result) }],
    };
  });

  await server.connect(transport);
  reply.raw.once("close", () => { void server.close().catch(() => undefined); });
  // Fastify already parsed and bounded the JSON. The SDK only needs the
  // canonical headers and a local URL to frame the protocol response.
  const headers = new Headers({ Accept: ACCEPT, "Content-Type": "application/json" });
  if (versions[0]) headers.set("MCP-Protocol-Version", versions[0]);
  const response = await transport.handleRequest(new Request("http://localhost" + MCP_PATH, { method: "POST", headers }), { parsedBody: body });
  if (beforeResponse) {
    await response.body?.cancel();
    await server.close();
    return failure(reply, request, beforeResponse);
  }
  const output = new Headers(response.headers);
  output.set("Cache-Control", "private, no-store");
  return reply.send(new Response(response.body, { status: response.status, headers: output }));
}

export function registerAgentIngress(fastify: FastifyInstance, gateway: AgentIngressGateway, options: AgentIngressOptions): void {
  void fastify.register(async (app) => {
    const clock = () => (options.now?.() ?? new Date()).getTime();
    const beforeAuth = new SlidingWindow(180);
    const afterAuth = new SlidingWindow(120);
    const credentials = new WeakMap<FastifyRequest, AgentCredential>();
    const duplicateSelectors = new WeakSet<FastifyRequest>();

    const parseJson = app.getDefaultJsonParser("error", "error");
    app.removeContentTypeParser("application/json");
    app.addContentTypeParser("application/json", { parseAs: "string", bodyLimit: BODY_LIMIT }, (request, body, done) => {
      const text = typeof body === "string" ? body : body.toString("utf8");
      parseJson(request, text, (error, value) => {
        if (!error && !isMcp(request) && object(value) && hasDuplicateBodySelector(text)) duplicateSelectors.add(request);
        done(error, value);
      });
    });

    app.setErrorHandler((error, request, reply) => {
      if (error instanceof AppError) return failure(reply, request, error);
      const retryable = agentDatastoreError(error);
      if (retryable) return failure(reply, request, retryable);
      const status = object(error) ? error.statusCode : undefined;
      if (status === 413) return failure(reply, request, new AppError(413, "body_too_large", "Agent request body is too large."));
      if (status === 415) return failure(reply, request, new AppError(415, "unsupported_media_type", "Use application/json."));
      if (status === 400) return failure(reply, request, invalidRequest(), ErrorCode.ParseError);
      request.log.error({ requestId: request.id }, "Agent request failed");
      return failure(reply, request, genericFailure());
    });

    app.addHook("onRequest", async (request, reply) => {
      reply.header("Cache-Control", "private, no-store");
      if (!options.enabled) return failure(reply, request, new AppError(404, "not_found", "Not Found"));
      const mcpRequest = isMcp(request);
      if (mcpRequest) {
        const origins = headerValues(request, "origin");
        if (origins.length > 1 || (origins.length === 1 && !options.allowedOrigins.includes(origins[0]!))) {
          return failure(reply, request, new AppError(403, "invalid_origin", "Origin is not allowed."));
        }
      }
      if (!beforeAuth.take(request.ip, clock())) return limited(reply, request);
      const auth = headerValues(request, "authorization");
      const token = auth.length === 1 && /^Bearer ([A-Za-z0-9_-]{43})$/i.exec(auth[0]!);
      if (!token) return failure(reply, request, new AppError(401, "unauthorized", "Agent Bearer authentication required."));
      const credential = await gateway.authenticate(token[1]!);
      if (!afterAuth.take(JSON.stringify([credential.agentId, request.ip]), clock())) return limited(reply, request);
      credentials.set(request, credential);

      if (mcpRequest && request.method !== "POST") {
        reply.header("Allow", "POST");
        return failure(reply, request, new AppError(405, "method_not_allowed", "Use POST for this Agent endpoint."));
      }
      if (mcpRequest && !acceptsBoth(request)) {
        return failure(reply, request, new AppError(406, "not_acceptable", "Accept both application/json and text/event-stream."));
      }
      if (request.method === "POST" && request.headers["content-type"]?.split(";", 1)[0]?.trim().toLowerCase() !== "application/json") {
        return failure(reply, request, new AppError(415, "unsupported_media_type", "Use application/json."));
      }
    });

    app.all("/mcp", { bodyLimit: BODY_LIMIT }, async (request, reply) => mcp(request, reply, gateway, credentials.get(request)!));
    app.get<{ Querystring: { actingUser?: unknown } }>("/v1/manifest", async (request) =>
      gateway.manifest(credentials.get(request)!, selector(request, request.query.actingUser)));
    app.get<{ Querystring: { actingUser?: unknown; uri?: unknown } }>("/v1/resources", async (request) => {
      const { uri } = request.query;
      if (typeof uri !== "string" || uri.length === 0 || uri.length > 2048) {
        throw new AppError(400, "invalid_request", "Supply one resource URI.");
      }
      return gateway.resource(credentials.get(request)!, selector(request, request.query.actingUser), uri);
    });
    app.post<{ Params: { toolName: string } }>("/v1/tools/:toolName", { bodyLimit: BODY_LIMIT }, async (request, reply) => {
      if (!object(request.body)) throw new AppError(400, "invalid_request", "Supply a JSON object for tool arguments.");
      if (duplicateSelectors.has(request)) throw new AppError(400, "invalid_acting_user", "Supply one valid acting-user selector.");
      const { _actingUser, ...args } = request.body;
      const result = await gateway.invoke(credentials.get(request)!, selector(request, _actingUser), request.params.toolName, args);
      return result.ok ? result : reply.code(result.status).send(result);
    });
  }, { prefix: "/api/agent" });
}
