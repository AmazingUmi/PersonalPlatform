import { AppError } from "../api/errors.js";

const rolledBackCodes = new Set(["40001", "40P01", "55P03", "57014"]);

export function agentDatastoreError(error: unknown): AppError | undefined {
  if (typeof error !== "object" || !error || !("code" in error)
      || typeof error.code !== "string" || !rolledBackCodes.has(error.code)) return undefined;
  return new AppError(503, "agent_datastore_busy", "The datastore is busy. Retry the Agent operation shortly.");
}
