import { api, ApiError } from "./api";

const BASE = "/api/core/data/sync";

/** Session is ending before the logout request finishes. Sync must abort immediately. */
export const SESSION_ENDING_EVENT = "pp:session-ending";

/** User-scoped notice that a cycle applied or bootstrapped data. No row contents. */
export const SYNC_DATA_CHANGED = "pp:sync-data-changed";

export interface SyncStatus {
  linked: boolean;
  enabled: boolean;
  phase: string;
  intervalSeconds: number;
  identityId: string | null;
  openConflicts: number;
  lastError: string | null;
  backoffUntil: string | null;
  baseline: boolean;
  pending: boolean;
  result?: string;
  /** Set by the server when a cycle or choice actually wrote rows. Omitted means use the result name. */
  dataChanged?: boolean;
}

export interface SyncConflict {
  id: string;
  syncKey: string;
  reason: string;
  local: Record<string, unknown> | null;
  remote: Record<string, unknown> | null;
  baseHash: string | null;
}

export interface SyncDataChangedDetail {
  userId: string;
  identityId: string | null;
  result: string;
  baseline: boolean;
  openConflicts: number;
  dataChanged?: boolean;
}

const APPLIED_RESULTS = new Set(["bootstrap", "committed", "published", "conflicted"]);
const MIN_COOLDOWN_MS = 15_000;
const MAX_BACKOFF_MS = 30 * 60_000;

export function appliedSyncResult(result: string | undefined): boolean {
  return result !== undefined && APPLIED_RESULTS.has(result);
}

/** `dataChanged` decides refresh when the server sends it, including an idle cycle that wrote rows. */
export function syncRefreshesApps(status: Pick<SyncStatus, "result" | "dataChanged">): boolean {
  if (status.dataChanged === true) return true;
  if (status.dataChanged === false) return false;
  return appliedSyncResult(status.result);
}

/** Keep only the status fields the product shows. Extra API fields, including a pairing code, are dropped. */
export function publicSyncStatus(raw: object): SyncStatus {
  const source = raw as Record<string, unknown>;
  const interval = source.intervalSeconds;
  const status: SyncStatus = {
    linked: source.linked === true,
    enabled: source.enabled === true,
    phase: typeof source.phase === "string" ? source.phase : "unlinked",
    intervalSeconds: interval === 0 || interval === 60 || interval === 120 ? interval : 120,
    identityId: typeof source.identityId === "string" ? source.identityId : null,
    openConflicts: typeof source.openConflicts === "number" && Number.isFinite(source.openConflicts) ? source.openConflicts : 0,
    lastError: typeof source.lastError === "string" ? source.lastError : null,
    backoffUntil: typeof source.backoffUntil === "string" ? source.backoffUntil : null,
    baseline: source.baseline === true,
    pending: source.pending === true,
  };
  if (typeof source.result === "string") status.result = source.result;
  if (source.dataChanged === true || source.dataChanged === false) status.dataChanged = source.dataChanged;
  return status;
}

const json = (method: string, body: unknown, signal?: AbortSignal): RequestInit => ({
  method, headers: { "content-type": "application/json" }, body: JSON.stringify(body), signal,
});

export const getSyncStatus = (signal?: AbortSignal) => api<SyncStatus>(BASE, { signal }).then(publicSyncStatus);
export const createSyncIdentity = (signal?: AbortSignal) =>
  api<SyncStatus & { pairingCode: string }>(BASE, json("POST", { action: "create" }, signal)).then(body => ({ ...publicSyncStatus(body), pairingCode: body.pairingCode }));
export const joinSyncIdentity = (pairingCode: string, signal?: AbortSignal) =>
  api<SyncStatus>(BASE, json("POST", { action: "join", pairingCode }, signal)).then(publicSyncStatus);
export const configureSync = (input: { enabled?: boolean; intervalSeconds?: number }, signal?: AbortSignal) =>
  api<SyncStatus>(BASE, json("PUT", input, signal)).then(publicSyncStatus);
export const unlinkSync = (signal?: AbortSignal) => api<unknown>(BASE, { method: "DELETE", signal }).then(() => undefined);
export const revealSyncPairing = (signal?: AbortSignal) => api<{ pairingCode: string }>(`${BASE}/reveal`, { method: "POST", signal });
export const cycleSync = (signal?: AbortSignal) => api<SyncStatus>(`${BASE}/cycle`, { method: "POST", signal }).then(publicSyncStatus);
export const listSyncConflicts = (signal?: AbortSignal) => api<{ items: SyncConflict[] }>(`${BASE}/conflicts`, { signal });
export const resolveSyncConflict = (id: string, choice: "keep-local" | "keep-remote", signal?: AbortSignal) =>
  api<SyncStatus>(`${BASE}/conflicts/${encodeURIComponent(id)}`, json("POST", { choice }, signal)).then(publicSyncStatus);

export interface SyncClient {
  status(signal: AbortSignal): Promise<SyncStatus>;
  create(signal: AbortSignal): Promise<SyncStatus & { pairingCode: string }>;
  join(pairingCode: string, signal: AbortSignal): Promise<SyncStatus>;
  configure(input: { enabled?: boolean; intervalSeconds?: number }, signal: AbortSignal): Promise<SyncStatus>;
  unlink(signal: AbortSignal): Promise<void>;
  reveal(signal: AbortSignal): Promise<{ pairingCode: string }>;
  cycle(signal: AbortSignal): Promise<SyncStatus>;
  conflicts(signal: AbortSignal): Promise<{ items: SyncConflict[] }>;
  resolve(id: string, choice: "keep-local" | "keep-remote", signal: AbortSignal): Promise<SyncStatus>;
}

export const httpSyncClient: SyncClient = {
  status: getSyncStatus,
  create: createSyncIdentity,
  join: joinSyncIdentity,
  configure: configureSync,
  unlink: unlinkSync,
  reveal: revealSyncPairing,
  cycle: cycleSync,
  conflicts: listSyncConflicts,
  resolve: resolveSyncConflict,
};

export interface SyncListener {
  onStatus(status: SyncStatus | null): void;
  onError(error: unknown): void;
  onActivity(active: boolean): void;
  onDataChanged(detail: SyncDataChangedDetail): void;
  onPeerStatus(status: SyncStatus): void;
}

interface TimerHandle { cancel(): void }

export interface SyncRuntime {
  now(): number;
  random(): number;
  schedule(run: () => void, delayMs: number): TimerHandle;
  locks?: { request(name: string, options: { ifAvailable?: boolean }, callback: (lock: unknown) => Promise<void>): Promise<void> } | null;
  channel(name: string): { postMessage(data: unknown): void; close(): void; onMessage(handler: (data: unknown) => void): void } | null;
}

type BroadcastMessage = { userId: string; kind: "status"; status: SyncStatus; cycled: boolean } | { userId: string; kind: "data-changed"; detail: SyncDataChangedDetail };

export function browserSyncRuntime(): SyncRuntime {
  return {
    now: () => Date.now(),
    random: () => Math.random(),
    schedule(run, delayMs) {
      const id = setTimeout(run, delayMs);
      return { cancel: () => clearTimeout(id) };
    },
    locks: typeof navigator !== "undefined" && navigator.locks ? navigator.locks : null,
    channel(name) {
      if (typeof BroadcastChannel === "undefined") return null;
      const channel = new BroadcastChannel(name);
      return {
        postMessage: (data) => channel.postMessage(data),
        close: () => channel.close(),
        onMessage: (handler) => { channel.onmessage = (event) => handler(event.data); },
      };
    },
  };
}

function isAbort(error: unknown): boolean {
  return error instanceof DOMException && error.name === "AbortError" || error instanceof Error && error.name === "AbortError";
}

function errorCode(error: unknown): string {
  return error instanceof ApiError && error.code ? error.code : "";
}

export class SyncLocalBusyError extends Error {
  readonly code = "sync_busy_local";
  constructor() {
    super("Continuous sync is already running in another open tab.");
    this.name = "SyncLocalBusyError";
  }
}

/**
 * One loop per signed-in user. Status refresh is a GET. A cycle is single-flight
 * and coordinated across tabs. Logout, user change, and 401 abort the current fetch.
 */
export class SyncController {
  private generation = 0;
  private alive = false;
  private abort = new AbortController();
  private timer: TimerHandle | null = null;
  private flight: Promise<void> | null = null;
  private status: SyncStatus | null = null;
  private lastCycleAt = 0;
  private failureAttempt = 0;
  private clientBackoffUntil = 0;
  private followBootstrap = false;
  private followAttempts = 0;
  private statusAttempt = 0;
  private statusRetry = false;
  private lane: Promise<void> = Promise.resolve();
  private channel: ReturnType<SyncRuntime["channel"]> = null;
  /** Bumps on every local or applied status write so a late GET cannot cover a newer action. */
  private mutationEpoch = 0;
  private peerRefreshActive = false;
  private peerRefreshAgain = false;

  constructor(
    readonly userId: string,
    private readonly client: SyncClient,
    private readonly runtime: SyncRuntime,
    private readonly listener: SyncListener,
  ) {}

  async start(): Promise<void> {
    if (this.alive) return;
    this.alive = true;
    this.openChannel();
    await this.pullStatus();
    if (!this.alive || !this.status) return;
    await this.nudge("login");
  }

  /** Abort in-flight work and forget schedule. Safe to call more than once. */
  stop(): void {
    this.generation += 1;
    this.alive = false;
    this.followBootstrap = false;
    this.timer?.cancel();
    this.timer = null;
    this.abort.abort();
    this.abort = new AbortController();
    this.flight = null;
    this.listener.onActivity(false);
    this.channel?.close();
    this.channel = null;
    this.status = null;
    this.listener.onStatus(null);
    this.listener.onActivity(false);
  }

  async nudge(reason: "login" | "focus" | "online"): Promise<void> {
    if (!this.alive) return;
    if (this.shouldCycleNow()) {
      await this.runCycle("auto");
      return;
    }
    if (reason !== "login") await this.pullStatus();
    this.arm(this.delayUntilDue());
  }

  async refresh(): Promise<void> {
    await this.pullStatus();
  }

  async createAndEnable(): Promise<string> {
    return this.enqueue(() => this.linkAndCycle("create"));
  }

  async joinAndEnable(pairingCode: string): Promise<void> {
    await this.enqueue(() => this.linkAndCycle("join", pairingCode));
  }

  async configure(input: { enabled?: boolean; intervalSeconds?: number }): Promise<void> {
    await this.enqueue(async () => {
      const signal = this.abort.signal;
      const status = publicSyncStatus(await this.client.configure(input, signal));
      this.ensureCurrent(signal);
      this.adopt(status);
      if (!status.enabled || status.intervalSeconds === 0) this.followBootstrap = false;
      if (this.shouldCycleNow()) await this.executeCycle("auto", this.generation);
      else this.arm(this.delayUntilDue());
    });
  }

  async syncNow(): Promise<void> {
    await this.runCycle("manual");
  }

  async reveal(): Promise<string> {
    return this.enqueue(async () => {
      const signal = this.abort.signal;
      const body = await this.client.reveal(signal);
      this.ensureCurrent(signal);
      return body.pairingCode;
    });
  }

  async unlink(): Promise<void> {
    await this.enqueue(async () => {
      const signal = this.abort.signal;
      await this.client.unlink(signal);
      this.ensureCurrent(signal);
      this.followBootstrap = false;
      this.adopt({
        linked: false, enabled: false, phase: "unlinked", intervalSeconds: 120, identityId: null,
        openConflicts: 0, lastError: null, backoffUntil: null, baseline: false, pending: false,
      });
    });
  }

  async conflicts(): Promise<SyncConflict[]> {
    const generation = this.generation;
    const signal = this.abort.signal;
    const body = await this.client.conflicts(signal);
    if (generation !== this.generation || signal.aborted) throw new DOMException("Aborted", "AbortError");
    return body.items;
  }

  async resolve(id: string, choice: "keep-local" | "keep-remote"): Promise<void> {
    await this.enqueue(async () => {
      const signal = this.abort.signal;
      const status = publicSyncStatus(await this.client.resolve(id, choice, signal));
      this.ensureCurrent(signal);
      this.adopt(status);
      if (syncRefreshesApps(status)) this.emitChanged(status, status.result ?? "resolved");
    });
  }

  private async linkAndCycle(action: "create" | "join", pairingCode = ""): Promise<string> {
    const signal = this.abort.signal;
    const created = action === "create" ? await this.client.create(signal) : await this.client.join(pairingCode, signal);
    this.ensureCurrent(signal);
    const code = "pairingCode" in created && typeof created.pairingCode === "string" ? created.pairingCode : "";
    this.adopt(publicSyncStatus(created));
    const configured = publicSyncStatus(await this.client.configure({ enabled: true, intervalSeconds: 120 }, signal));
    this.ensureCurrent(signal);
    this.adopt(configured);
    this.followBootstrap = true;
    this.followAttempts = 0;
    await this.executeCycle("manual", this.generation);
    this.ensureCurrent(signal);
    return code;
  }

  private ensureCurrent(signal: AbortSignal): void {
    if (!this.alive || signal.aborted || signal !== this.abort.signal) throw new DOMException("Aborted", "AbortError");
  }

  private enqueue<T>(work: () => Promise<T>): Promise<T> {
    const generation = this.generation;
    const next = this.lane.then(async () => {
      if (!this.alive || generation !== this.generation) throw new DOMException("Aborted", "AbortError");
      this.listener.onActivity(true);
      try { return await work(); }
      catch (error) {
        if (generation !== this.generation || isAbort(error)) throw new DOMException("Aborted", "AbortError");
        if (errorCode(error) === "unauthorized" || error instanceof ApiError && error.status === 401) this.stop();
        throw error;
      }
      finally { if (generation === this.generation) this.listener.onActivity(false); }
    });
    this.lane = next.then(() => undefined, () => undefined);
    return next;
  }

  private adopt(status: SyncStatus, broadcast = true): void {
    this.mutationEpoch += 1;
    this.status = status;
    this.listener.onStatus(status);
    if (broadcast) this.broadcast({ userId: this.userId, kind: "status", status, cycled: false });
    else this.listener.onPeerStatus(status);
  }

  private async pullStatus(): Promise<void> {
    const generation = this.generation;
    try {
      const status = publicSyncStatus(await this.client.status(this.abort.signal));
      if (generation !== this.generation) return;
      this.statusAttempt = 0;
      this.adopt(status);
      if (this.shouldCycleNow()) await this.runCycle("auto");
      else this.arm(this.delayUntilDue());
    } catch (error) {
      if (generation !== this.generation || isAbort(error)) return;
      if (error instanceof ApiError && error.status === 401) {
        this.stop();
        return;
      }
      this.statusAttempt = Math.min(8, this.statusAttempt + 1);
      const wait = Math.min(MAX_BACKOFF_MS, Math.max(MIN_COOLDOWN_MS, 2_000 * 2 ** (this.statusAttempt - 1)));
      this.listener.onError(error);
      this.statusRetry = true;
      this.arm(wait);
    }
  }

  private shouldCycleNow(): boolean {
    const status = this.status;
    if (!this.alive || !status?.linked || !status.enabled || status.intervalSeconds === 0) return false;
    if (status.backoffUntil && Date.parse(status.backoffUntil) > this.runtime.now()) return false;
    if (this.clientBackoffUntil > this.runtime.now()) return false;
    if (this.lastCycleAt > 0) {
      const elapsed = this.runtime.now() - this.lastCycleAt;
      if (elapsed < Math.max(status.intervalSeconds * 1000, MIN_COOLDOWN_MS)) return false;
    }
    return true;
  }

  private delayUntilDue(): number {
    const status = this.status;
    if (!this.alive || !status?.linked || !status.enabled || status.intervalSeconds === 0) return -1;
    const now = this.runtime.now();
    const intervalWait = this.lastCycleAt > 0 ? status.intervalSeconds * 1000 - (now - this.lastCycleAt) : 0;
    const serverBackoff = status.backoffUntil ? Date.parse(status.backoffUntil) - now : 0;
    const clientBackoff = this.clientBackoffUntil - now;
    const cooldown = this.lastCycleAt > 0 ? MIN_COOLDOWN_MS - (now - this.lastCycleAt) : 0;
    return Math.max(0, intervalWait, serverBackoff, clientBackoff, cooldown);
  }

  /** Continue a first sync only while automatic sync is allowed and backoff has passed. */
  private followCanRun(): boolean {
    const status = this.status;
    if (!this.alive || !this.followBootstrap || this.followAttempts >= 8 || !status) return false;
    if (!status.linked || !status.enabled || status.intervalSeconds === 0) return false;
    if (status.phase !== "bootstrap" || status.baseline) return false;
    if (status.backoffUntil && Date.parse(status.backoffUntil) > this.runtime.now()) return false;
    if (this.clientBackoffUntil > this.runtime.now()) return false;
    return true;
  }

  private arm(delayMs: number): void {
    this.timer?.cancel();
    this.timer = null;
    if (!this.alive) return;
    let delay = delayMs;
    if (this.followBootstrap && this.followAttempts >= 8) this.followBootstrap = false;
    if (this.followBootstrap && this.status?.phase === "bootstrap" && !this.status.baseline) {
      if (!this.status.enabled || this.status.intervalSeconds === 0) {
        this.followBootstrap = false;
        delay = -1;
      } else {
        const now = this.runtime.now();
        const serverBackoff = this.status.backoffUntil ? Date.parse(this.status.backoffUntil) - now : 0;
        const clientBackoff = this.clientBackoffUntil - now;
        delay = Math.max(4_000, serverBackoff, clientBackoff);
      }
    }
    // A delay of 0 means "due now". Callers run that cycle themselves. Scheduling 0 loops.
    if (delay < 1_000) return;
    const retryStatus = this.statusRetry;
    this.statusRetry = false;
    this.timer = this.runtime.schedule(() => {
      if (!this.alive) return;
      if (retryStatus) {
        void this.pullStatus();
        return;
      }
      if (this.followCanRun() || this.shouldCycleNow()) void this.runCycle("auto");
      else this.arm(this.delayUntilDue());
    }, delay);
  }

  async runCycle(source: "auto" | "manual"): Promise<void> {
    if (!this.alive) return;
    if (this.flight) return this.flight;
    const generation = this.generation;
    const job = this.enqueue(() => this.executeCycle(source, generation)).finally(() => {
      if (this.flight === job) this.flight = null;
    });
    this.flight = job;
    return job;
  }

  private async executeCycle(source: "auto" | "manual", generation: number): Promise<void> {
    if (source === "auto" && !this.shouldCycleNow() && !this.followCanRun()) {
      this.arm(this.delayUntilDue());
      return;
    }
    try {
      const signal = this.abort.signal;
      const outcome = await this.withLock(() => this.client.cycle(signal));
      if (generation !== this.generation || signal.aborted) return;
      if (outcome === "locked") {
        if (source === "manual") this.listener.onError(new SyncLocalBusyError());
        this.clientBackoffUntil = this.runtime.now() + MIN_COOLDOWN_MS;
        this.arm(MIN_COOLDOWN_MS);
        return;
      }
      const status = publicSyncStatus(outcome);
      this.lastCycleAt = this.runtime.now();
      this.failureAttempt = 0;
      this.clientBackoffUntil = 0;
      this.mutationEpoch += 1;
      this.status = status;
      this.listener.onStatus(status);
      this.broadcast({ userId: this.userId, kind: "status", status, cycled: true });
      if (syncRefreshesApps(status)) this.emitChanged(status, status.result ?? "");
      if (!status.enabled || status.intervalSeconds === 0) this.followBootstrap = false;
      if (this.followBootstrap && status.phase === "bootstrap" && !status.baseline && (status.result === "partial" || status.result === "bootstrap")) {
        this.followAttempts += 1;
        if (this.followAttempts >= 8) this.followBootstrap = false;
      } else if (status.baseline || status.phase === "linked" || status.result === "conflicted" || status.result === "idle") {
        this.followBootstrap = false;
      }
      this.arm(this.delayUntilDue());
    } catch (error) {
      if (generation !== this.generation || isAbort(error)) return;
      if (error instanceof ApiError && error.status === 401) {
        this.stop();
        return;
      }
      const code = errorCode(error);
      this.failureAttempt = Math.min(8, this.failureAttempt + 1);
      const interval = Math.max(MIN_COOLDOWN_MS, (this.status?.intervalSeconds || 120) * 1000);
      const base = code === "sync_busy" ? interval : Math.min(MAX_BACKOFF_MS, 2_000 * 2 ** (this.failureAttempt - 1));
      const wait = code === "sync_busy" ? Math.max(MIN_COOLDOWN_MS, base) : Math.min(MAX_BACKOFF_MS, Math.max(MIN_COOLDOWN_MS, base * (0.8 + this.runtime.random() * 0.4)));
      this.clientBackoffUntil = this.runtime.now() + wait;
      this.listener.onError(error);
      this.arm(this.status?.enabled && this.status.intervalSeconds > 0 ? wait : -1);
    }
  }

  private emitChanged(status: SyncStatus, result: string): void {
    const detail: SyncDataChangedDetail = {
      userId: this.userId, identityId: status.identityId, result, baseline: status.baseline, openConflicts: status.openConflicts,
      ...(typeof status.dataChanged === "boolean" ? { dataChanged: status.dataChanged } : {}),
    };
    this.listener.onDataChanged(detail);
    this.broadcast({ userId: this.userId, kind: "data-changed", detail });
    if (typeof window !== "undefined") window.dispatchEvent(new CustomEvent(SYNC_DATA_CHANGED, { detail }));
  }

  /** ifAvailable must not be combined with a signal; browsers reject that pair. */
  private async withLock<T>(fn: () => Promise<T>): Promise<T | "locked"> {
    const locks = this.runtime.locks;
    if (!locks) return fn();
    const generation = this.generation;
    const signal = this.abort.signal;
    let outcome: T | "locked" = "locked";
    await locks.request(`pp-sync:${this.userId}`, { ifAvailable: true }, async (lock) => {
      if (!lock || !this.alive || generation !== this.generation || signal.aborted) {
        outcome = "locked";
        return;
      }
      outcome = await fn();
    });
    return outcome;
  }

  private openChannel(): void {
    this.channel = this.runtime.channel(`pp-sync:${this.userId}`);
    this.channel?.onMessage((data) => {
      if (!this.alive || !data || typeof data !== "object") return;
      try {
        if (!data || typeof data !== "object") return;
        const message = data as Partial<BroadcastMessage>;
        if (message.userId !== this.userId) return;
        if (message.kind === "data-changed" && message.detail && message.detail.userId === this.userId) {
          if (this.status?.identityId && message.detail.identityId && message.detail.identityId !== this.status.identityId) return;
          this.listener.onDataChanged(message.detail);
          if (typeof window !== "undefined") window.dispatchEvent(new CustomEvent(SYNC_DATA_CHANGED, { detail: message.detail }));
          return;
        }
        if (message.kind === "status" && message.status && typeof message.status === "object") {
          const incoming = publicSyncStatus(message.status);
          const local = this.status;
          const sameIdentity = !local?.linked || !local.identityId || !incoming.identityId || incoming.identityId === local.identityId;
          if (sameIdentity && message.cycled) this.lastCycleAt = this.runtime.now();
          this.requestPeerRefresh();
        }
      } catch { /* ignore malformed messages */ }
    });
  }

  private broadcast(message: BroadcastMessage): void {
    try { this.channel?.postMessage(message); } catch { /* channel closed */ }
  }

  /**
   * Peer notifications are hints. The next GET is authoritative and is not broadcast,
   * so two tabs cannot ping-pong the same status. A GET that started before a newer
   * local write is dropped via mutationEpoch.
   */
  private requestPeerRefresh(): void {
    if (!this.alive) return;
    if (this.peerRefreshActive) {
      this.peerRefreshAgain = true;
      return;
    }
    this.peerRefreshActive = true;
    const generation = this.generation;
    const epoch = this.mutationEpoch;
    void this.runPeerRefresh(generation, epoch);
  }

  private async runPeerRefresh(generation: number, epoch: number): Promise<void> {
    try {
      if (!this.alive || generation !== this.generation || epoch !== this.mutationEpoch) return;
      const signal = this.abort.signal;
      let status: SyncStatus;
      try {
        status = publicSyncStatus(await this.client.status(signal));
      } catch (error) {
        if (generation !== this.generation || isAbort(error)) return;
        if (error instanceof ApiError && error.status === 401) {
          this.stop();
          return;
        }
        this.listener.onError(error);
        return;
      }
      if (!this.alive || generation !== this.generation || epoch !== this.mutationEpoch || signal.aborted) return;
      await this.enqueue(async () => {
        if (generation !== this.generation || epoch !== this.mutationEpoch) return;
        this.adopt(status, false);
        this.arm(this.delayUntilDue());
      });
    } catch (error) {
      if (generation !== this.generation || isAbort(error)) return;
    } finally {
      this.peerRefreshActive = false;
      if (this.peerRefreshAgain && this.alive && generation === this.generation) {
        this.peerRefreshAgain = false;
        this.requestPeerRefresh();
      } else {
        this.peerRefreshAgain = false;
      }
    }
  }
}

const HIDDEN_FIELDS = new Set([
  "user_id", "storage_key", "revision", "updated_at", "content_sha256", "bytes", "blob", "ciphertext", "password", "secret",
]);

export function conflictRecordLabel(syncKey: string): { table: string; record: string } {
  const split = syncKey.indexOf(":");
  const table = split === -1 ? syncKey : syncKey.slice(0, split);
  const record = split === -1 ? "" : syncKey.slice(split + 1);
  return { table, record };
}

function readable(value: unknown): string | null {
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") return String(value);
  if (!Array.isArray(value)) return null;
  const parts = value.filter((item) => typeof item === "string" || typeof item === "number" || typeof item === "boolean").map(String);
  return parts.length > 0 ? parts.join(", ") : null;
}

export function conflictFieldEntries(row: Record<string, unknown> | null): { key: string; value: string }[] {
  if (!row) return [];
  const entries: { key: string; value: string }[] = [];
  for (const [key, value] of Object.entries(row)) {
    if (HIDDEN_FIELDS.has(key) || value === null || value === undefined) continue;
    const plain = readable(value);
    if (plain !== null) {
      entries.push({ key, value: plain });
      continue;
    }
    if (typeof value === "object" && !Array.isArray(value)) {
      for (const [child, inner] of Object.entries(value)) {
        const text = readable(inner);
        if (text !== null && !HIDDEN_FIELDS.has(child)) entries.push({ key: `${key}.${child}`, value: text });
      }
    }
  }
  return entries;
}

export function attachmentSummary(row: Record<string, unknown> | null): { filename: string; type: string; size: string } | null {
  if (!row) return null;
  const filename = row.filename ?? row.original_filename ?? row.name;
  if (typeof filename !== "string") return null;
  const type = typeof row.content_type === "string" ? row.content_type : typeof row.mime === "string" ? row.mime : "";
  const rawSize = row.size ?? row.byte_size;
  const size = typeof rawSize === "number" || typeof rawSize === "string" ? String(rawSize) : "";
  if (!type && !size && !("content_type" in row) && !("size" in row)) return null;
  return { filename, type, size };
}
