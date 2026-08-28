export interface HealthCheck {
  status: "ok" | "error";
  message?: string;
}

export interface HealthResult {
  status: "ok" | "degraded" | "error";
  checks: Record<string, HealthCheck>;
}

export function aggregateHealth(checks: Record<string, HealthCheck>): HealthResult {
  const statuses = Object.values(checks).map((check) => check.status);
  const status: HealthResult["status"] = statuses.some((s) => s === "error")
    ? "error"
    : "ok";
  return { status, checks };
}

export function okHealth(checks: Record<string, HealthCheck> = {}): HealthResult {
  return { status: "ok", checks };
}
