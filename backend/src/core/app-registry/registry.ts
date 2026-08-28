import type { Database } from "../database/index.js";
import type { Logger } from "../logging/index.js";
import { AppError } from "../api/errors.js";
import { duplicateIds, scanApps } from "./scanner.js";
import type { AppManifest, AppRecord, AppStatus, BackendAppModule } from "./types.js";

export interface AppRegistryOptions {
  manifestsDir: string;
  database: Database | null;
  backendModules: Record<string, BackendAppModule>;
  frontendAppIds?: string[];
  configEnabled?: Record<string, boolean>;
  log?: Logger;
}

interface PersistedApp {
  enabled: boolean;
  status: string;
}

function defaultRecord(id: string): AppRecord {
  return {
    id,
    name: id,
    version: "0.0.0",
    description: "",
    status: "error",
    enabled: false,
    defaultEnabled: false,
    route: `/${id}`,
    capabilities: { database: false, storage: false, scheduler: false, events: false },
    widgets: [],
    hasBackend: false,
    hasFrontend: false,
  };
}

/**
 * Owns app discovery, status computation and persistence. It never imports
 * business code directly — compiled modules are injected as a static map.
 */
export class AppRegistry {
  private readonly records = new Map<string, AppRecord>();
  private readonly manifests = new Map<string, AppManifest | null>();
  private readonly backendModules: Record<string, BackendAppModule>;
  private readonly frontendAppIds: Set<string>;
  private readonly configEnabled: Record<string, boolean>;

  constructor(private readonly options: AppRegistryOptions) {
    this.backendModules = options.backendModules;
    this.frontendAppIds = new Set(options.frontendAppIds ?? []);
    this.configEnabled = options.configEnabled ?? {};
  }

  async init(): Promise<void> {
    const scanned = scanApps(this.options.manifestsDir);
    const dupes = new Set(duplicateIds(scanned));
    const persisted = await this.loadPersisted();

    for (const app of scanned) {
      const manifest = app.manifest;
      this.manifests.set(app.id, manifest);

      if (!manifest || dupes.has(app.id) || app.errors.length > 0) {
        const errors = dupes.has(app.id) ? ["duplicate app id"] : app.errors;
        const record: AppRecord = {
          ...defaultRecord(app.id),
          errorMessage: errors.join("; "),
        };
        this.records.set(app.id, record);
        await this.persistApp(record);
        continue;
      }

      const hasBackend = Boolean(this.backendModules[manifest.id]);
      const hasFrontend = this.frontendAppIds.has(manifest.id);
      const enabled = this.resolveEnabled(manifest, persisted.get(manifest.id));
      const status = computeStatus(enabled, hasBackend, hasFrontend);

      const record: AppRecord = {
        id: manifest.id,
        name: manifest.name,
        version: manifest.version,
        description: manifest.description,
        status,
        enabled: status === "enabled",
        defaultEnabled: manifest.default_enabled,
        route: manifest.frontend.route,
        capabilities: manifest.capabilities,
        widgets: manifest.widgets,
        hasBackend,
        hasFrontend,
      };
      this.records.set(manifest.id, record);
      await this.persistApp(record);
    }

    this.options.log?.info({ apps: this.getApps().length }, "app registry initialized");
  }

  getApps(): AppRecord[] {
    return [...this.records.values()].sort((a, b) => a.id.localeCompare(b.id));
  }

  get(id: string): AppRecord | undefined {
    return this.records.get(id);
  }

  getStatus(id: string): AppStatus | undefined {
    return this.records.get(id)?.status;
  }

  isEnabled(id: string): boolean {
    return this.records.get(id)?.status === "enabled";
  }

  hasValidManifest(id: string): boolean {
    return (this.manifests.get(id) ?? null) !== null;
  }

  /** Persist a runtime error and flip the app to `error` state. */
  markError(id: string, message: string): AppRecord | undefined {
    const record = this.records.get(id);
    if (!record) return undefined;
    const updated: AppRecord = { ...record, status: "error", enabled: false, errorMessage: message };
    this.records.set(id, updated);
    void this.persistApp(updated);
    return updated;
  }

  async setEnabled(id: string, enabled: boolean): Promise<AppRecord> {
    const record = this.records.get(id);
    if (!record) throw new AppError(404, "app_not_found", `app "${id}" not found`);
    if (enabled && !this.hasValidManifest(id)) {
      throw new AppError(400, "app_invalid", `app "${id}" has an invalid manifest and cannot be enabled`);
    }

    await this.persistEnabled(id, enabled);
    const status: AppStatus = enabled ? "enabled" : "disabled";
    const updated: AppRecord = {
      ...record,
      status,
      enabled,
      errorMessage: enabled ? undefined : record.errorMessage,
    };
    this.records.set(id, updated);
    return updated;
  }

  private resolveEnabled(manifest: AppManifest, persisted?: PersistedApp): boolean {
    if (persisted) return persisted.enabled;
    if (manifest.id in this.configEnabled) return this.configEnabled[manifest.id]!;
    return manifest.default_enabled;
  }

  private async loadPersisted(): Promise<Map<string, PersistedApp>> {
    const db = this.options.database;
    if (!db) return new Map();
    try {
      const result = await db.context().query<{ id: string; enabled: boolean; status: string }>(
        "SELECT id, enabled, status FROM core.apps",
      );
      const map = new Map<string, PersistedApp>();
      for (const row of result.rows) map.set(row.id, { enabled: row.enabled, status: row.status });
      return map;
    } catch (error) {
      this.options.log?.warn({ error }, "failed to load persisted app state");
      return new Map();
    }
  }

  private async persistApp(record: AppRecord): Promise<void> {
    const db = this.options.database;
    if (!db) return;
    try {
      await db.context().query(
        `INSERT INTO core.apps (id, name, version, status, enabled, error_message, installed_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, now(), now())
         ON CONFLICT (id) DO UPDATE
           SET name = EXCLUDED.name,
               version = EXCLUDED.version,
               status = EXCLUDED.status,
               error_message = EXCLUDED.error_message,
               updated_at = now()`,
        [record.id, record.name, record.version, record.status, record.enabled, record.errorMessage ?? null],
      );
    } catch (error) {
      this.options.log?.error({ error, appId: record.id }, "failed to persist app state");
    }
  }

  private async persistEnabled(id: string, enabled: boolean): Promise<void> {
    const db = this.options.database;
    if (!db) return;
    const status = enabled ? "enabled" : "disabled";
    await db
      .context()
      .query("UPDATE core.apps SET enabled = $2, status = $3, updated_at = now() WHERE id = $1", [
        id,
        enabled,
        status,
      ]);
  }
}

function computeStatus(enabled: boolean, _hasBackend: boolean, _hasFrontend: boolean): AppStatus {
  return enabled ? "enabled" : "disabled";
}
