import { Ajv, type ErrorObject } from "ajv";
import type { AppManifest, ManifestCapabilities, ManifestWidget } from "./types.js";

const manifestSchema = {
  type: "object",
  additionalProperties: false,
  required: [
    "manifest_version",
    "id",
    "name",
    "version",
    "description",
    "default_enabled",
    "frontend",
    "capabilities",
  ],
  properties: {
    manifest_version: { type: "integer", const: 1 },
    id: { type: "string", pattern: "^[a-z][a-z0-9_]*$" },
    name: { type: "string", minLength: 1 },
    version: { type: "string", pattern: "^\\d+\\.\\d+\\.\\d+$" },
    description: { type: "string" },
    default_enabled: { type: "boolean" },
    frontend: {
      type: "object",
      additionalProperties: false,
      required: ["route"],
      properties: {
        route: { type: "string", pattern: "^/" },
      },
    },
    widgets: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["id", "name"],
        properties: {
          id: { type: "string", pattern: "^[a-z][a-z0-9_]*$" },
          name: { type: "string", minLength: 1 },
        },
      },
    },
    capabilities: {
      type: "object",
      additionalProperties: false,
      properties: {
        database: { type: "boolean", default: false },
        storage: { type: "boolean", default: false },
        scheduler: { type: "boolean", default: false },
        events: { type: "boolean", default: false },
      },
    },
  },
} as const;

const ajv = new Ajv({ allErrors: true, useDefaults: true });
const validate = ajv.compile(manifestSchema);

function formatErrors(errors: ErrorObject[] | null | undefined): string[] {
  if (!errors) return [];
  return errors.map((e) => `${e.instancePath || "/"} ${e.message ?? "invalid"}`);
}

export type ManifestValidation =
  | { ok: true; manifest: AppManifest }
  | { ok: false; errors: string[] };

export function validateManifest(input: unknown): ManifestValidation {
  if (typeof input !== "object" || input === null) {
    return { ok: false, errors: ["manifest must be a mapping"] };
  }
  const valid = validate(input);
  if (!valid) {
    return { ok: false, errors: formatErrors(validate.errors) };
  }

  const data = input as unknown as Record<string, unknown>;
  const frontend = data["frontend"] as { route: string };
  const widgets = (data["widgets"] ?? []) as ManifestWidget[];
  const capabilities = (data["capabilities"] ?? {}) as Partial<ManifestCapabilities>;

  const manifest: AppManifest = {
    manifest_version: 1,
    id: data["id"] as string,
    name: data["name"] as string,
    version: data["version"] as string,
    description: data["description"] as string,
    default_enabled: data["default_enabled"] as boolean,
    frontend: { route: frontend.route },
    widgets: widgets.map((w) => ({ id: w.id, name: w.name })),
    capabilities: {
      database: capabilities.database ?? false,
      storage: capabilities.storage ?? false,
      scheduler: capabilities.scheduler ?? false,
      events: capabilities.events ?? false,
    },
  };

  return { ok: true, manifest };
}

/**
 * Cross-field rules that JSON Schema cannot express.
 */
export function semanticErrors(manifest: AppManifest): string[] {
  const errors: string[] = [];
  if (!manifest.frontend.route.startsWith(`/${manifest.id}`)) {
    errors.push(`frontend.route must be under /${manifest.id}`);
  }
  const widgetIds = new Set<string>();
  for (const widget of manifest.widgets) {
    if (widgetIds.has(widget.id)) {
      errors.push(`duplicate widget id "${widget.id}"`);
    }
    widgetIds.add(widget.id);
  }
  return errors;
}
