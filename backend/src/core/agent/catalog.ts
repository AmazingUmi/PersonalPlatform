import { Ajv, type ValidateFunction } from "ajv";
import { AppError } from "../api/errors.js";
import type { AppContext, ManifestCapabilities } from "../app-registry/types.js";
import { UUID, validTimestamp } from "../data-management/snapshot-schema.js";
import type {
  AgentArguments, AgentResourceDescription, AgentScope, AgentToolDescription,
  AppAgentContext, AppAgentInvocation, AppAgentResource, AppAgentTool,
} from "./types.js";

const TOOL_NAME = /^[a-z][a-z0-9_]{0,99}$/;
const RECEIPT_KEY = "^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$";
const SCOPES: ReadonlySet<AgentScope> = new Set(["read", "write", "delete"]);

export interface ListedAgentTool {
  readonly public: AgentToolDescription;
  readonly definition: AppAgentTool;
  arguments(input: unknown): AgentArguments;
}

export interface ListedAgentResource {
  readonly public: AgentResourceDescription;
  readonly definition: AppAgentResource;
}

export interface PublishedAgentApp {
  readonly id: string;
  readonly generation: symbol;
  readonly context: AppContext;
  readonly capabilities: Readonly<ManifestCapabilities>;
  readonly tools: ReadonlyMap<string, ListedAgentTool>;
  readonly resources: ReadonlyMap<string, ListedAgentResource>;
  readonly overview?: (ctx: AppAgentInvocation) => Promise<unknown>;
}

function schemasFor(tool: AppAgentTool): AgentToolDescription["inputSchema"] {
  const schema = structuredClone(tool.inputSchema);
  if (!tool.create) return schema;
  return {
    ...schema,
    properties: {
      ...(schema.properties as object | undefined),
      idempotencyKey: { type: "string", pattern: RECEIPT_KEY },
    },
    required: [...new Set([...((schema.required as string[] | undefined) ?? []), "idempotencyKey"])],
  };
}

function normalizedArguments(validate: ValidateFunction<AgentArguments>, input: unknown): AgentArguments {
  const value = structuredClone(input === undefined ? {} : input);
  if (!validate(value)) {
    const fields = validate.errors?.map(error => ({
      path: error.instancePath, keyword: error.keyword,
    }));
    throw new AppError(422, "invalid_arguments", "The tool arguments do not match its schema.", { fields });
  }
  return value;
}

function assertTool(appId: string, tool: AppAgentTool): void {
  const { name, action, scopes } = tool;
  if (!TOOL_NAME.test(name) || !name.startsWith(appId + "_") || !tool.description.trim()) {
    throw new Error("Invalid Agent tool name or description");
  }
  if (tool.inputSchema.type !== "object" || tool.inputSchema.additionalProperties !== false) {
    throw new Error("An Agent tool must declare an object argument schema with explicit properties");
  }
  if (!SCOPES.has(action) || !scopes.includes(action) || scopes.some(scope => !SCOPES.has(scope))) {
    throw new Error("Invalid Agent tool scopes");
  }
  if ((action === "delete" || (action === "write" && !tool.create)) && !scopes.includes("read")) {
    throw new Error("Changing an existing record requires read scope");
  }
  if ((tool.create && action !== "write") || (tool.prepareDelete && action !== "delete")) {
    throw new Error("Invalid Agent tool operation");
  }
}

export class AgentCatalog {
  private readonly validators = new Ajv({ allErrors: true, useDefaults: true })
    .addFormat("uuid", (value: string) => UUID.test(value.toLowerCase()))
    .addFormat("date-time", validTimestamp)
    .addFormat("date", (value: string) => {
      const date = new Date(value + "T00:00:00.000Z");
      return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
    });
  private readonly generations = new Map<string, symbol>();
  private readonly published = new Map<string, PublishedAgentApp>();

  invalidate(appId: string): symbol {
    const generation = Symbol(appId);
    this.generations.set(appId, generation);
    this.published.delete(appId);
    return generation;
  }

  get(appId: string): PublishedAgentApp | undefined {
    return this.published.get(appId);
  }

  all(): PublishedAgentApp[] {
    return [...this.published.values()];
  }

  async register(
    appId: string,
    generation: symbol,
    context: AppContext,
    capabilities: ManifestCapabilities,
    hook: (ctx: AppAgentContext) => Promise<void>,
  ): Promise<void> {
    if (this.generations.get(appId) !== generation) return;
    const activeCapabilities = Object.freeze({ ...capabilities });
    const tools = new Map<string, ListedAgentTool>();
    const resources = new Map<string, ListedAgentResource>();
    let overview: PublishedAgentApp["overview"];
    let open = true;
    const registration: AppAgentContext = {
      tool: (definition) => {
        if (!open) return;
        assertTool(appId, definition);
        if (tools.has(definition.name)) throw new Error("Duplicate Agent tool");
        const inputSchema = schemasFor(definition);
        const validate = this.validators.compile<AgentArguments>(inputSchema);
        const publicTool: AgentToolDescription = {
          name: definition.name,
          description: definition.description,
          inputSchema,
          annotations: {
            readOnlyHint: definition.action === "read",
            destructiveHint: definition.action === "delete",
            idempotentHint: definition.action === "read" || definition.create === true,
            ...definition.annotations,
          },
        };
        tools.set(definition.name, {
          public: publicTool,
          definition: { ...definition, scopes: [...definition.scopes] },
          arguments: input => normalizedArguments(validate, input),
        });
      },
      resource: (definition) => {
        if (!open) return;
        const prefix = `pp://apps/${appId}/`;
        if (!definition.uri.startsWith(prefix) || !definition.uri.slice(prefix.length) || resources.has(definition.uri)) {
          throw new Error("Invalid or duplicate Agent resource URI");
        }
        const { uri, name, description, mimeType } = definition;
        resources.set(uri, { definition: { ...definition }, public: { uri, name, description, mimeType: mimeType ?? "application/json" } });
      },
      overview: (provider) => {
        if (!open) return;
        if (overview) throw new Error("Duplicate Agent overview");
        overview = provider;
      },
    };
    try {
      await hook(registration);
    } finally {
      open = false;
    }
    if (this.generations.get(appId) === generation) {
      this.published.set(appId, { id: appId, generation, context, capabilities: activeCapabilities, tools, resources, overview });
    }
  }
}
