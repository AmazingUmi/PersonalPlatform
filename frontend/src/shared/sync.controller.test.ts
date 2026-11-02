import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "./api";
import {
  attachmentSummary, conflictFieldEntries, publicSyncStatus, SYNC_DATA_CHANGED, SyncController, SyncLocalBusyError,
  type SyncClient, type SyncListener, type SyncRuntime, type SyncStatus,
} from "./sync";

const linked: SyncStatus = {
  linked: true, enabled: true, phase: "linked", intervalSeconds: 120, identityId: "identity-1",
  openConflicts: 0, lastError: null, backoffUntil: null, baseline: true, pending: false,
};

function runtime(): SyncRuntime & { delays: number[]; fire(): void; fireDue(): boolean } {
  let now = 1_000_000;
  const queued: { run: () => void; delay: number; at: number }[] = [];
  return {
    now: () => now,
    random: () => 0,
    schedule(run, delayMs) {
      const entry = { run, delay: delayMs, at: now + delayMs };
      queued.push(entry);
      return { cancel: () => { const index = queued.indexOf(entry); if (index >= 0) queued.splice(index, 1); } };
    },
    locks: null,
    channel: () => null,
    get delays() { return queued.map((item) => item.delay); },
    fire() { const due = queued.splice(0, queued.length); for (const entry of due) entry.run(); },
    /** Move time to the next scheduled deadline and run only that callback. */
    fireDue() {
      const next = queued.reduce<(typeof queued)[number] | null>((soonest, entry) => !soonest || entry.at < soonest.at ? entry : soonest, null);
      if (!next) return false;
      now = next.at;
      const index = queued.indexOf(next);
      if (index >= 0) queued.splice(index, 1);
      next.run();
      return true;
    },
  };
}

function listener(): SyncListener & { statuses: (SyncStatus | null)[]; errors: unknown[]; changed: unknown[] } {
  const statuses: (SyncStatus | null)[] = [];
  const errors: unknown[] = [];
  const changed: unknown[] = [];
  return {
    statuses, errors, changed,
    onStatus: (status) => { statuses.push(status); },
    onError: (error) => { errors.push(error); },
    onActivity: () => undefined,
    onDataChanged: (detail) => { changed.push(detail); },
    onPeerStatus: () => undefined,
  };
}

function client(status: SyncStatus = { ...linked, linked: false, enabled: false, phase: "unlinked", baseline: false, identityId: null }): SyncClient {
  return {
    status: vi.fn(async () => status),
    create: vi.fn(async () => ({ ...linked, phase: "bootstrap", baseline: false, enabled: false, pairingCode: "ppss1.code" })),
    join: vi.fn(async () => ({ ...linked, phase: "bootstrap", baseline: false, enabled: false })),
    configure: vi.fn(async () => ({ ...linked, phase: "bootstrap", baseline: false, enabled: true })),
    unlink: vi.fn(async () => undefined),
    reveal: vi.fn(async () => ({ pairingCode: "ppss1.code" })),
    cycle: vi.fn(async () => ({ ...linked, result: "idle" })),
    conflicts: vi.fn(async () => ({ items: [] })),
    resolve: vi.fn(async () => linked),
  };
}

afterEach(() => { vi.restoreAllMocks(); });

type MemoryPort = ReturnType<SyncRuntime["channel"]> & { name: string; handler: ((data: unknown) => void) | null };

function memoryChannels(posts: unknown[]): { open: SyncRuntime["channel"]; ports: MemoryPort[] } {
  const ports: MemoryPort[] = [];
  return {
    ports,
    open(name: string) {
      const port = {
        name,
        handler: null as ((data: unknown) => void) | null,
        postMessage(data: unknown) {
          posts.push(data);
          for (const other of [...ports]) {
            if (other !== port && other.name === name && other.handler) other.handler(JSON.parse(JSON.stringify(data)));
          }
        },
        close() { port.handler = null; },
        onMessage(next: (data: unknown) => void) { port.handler = next; },
      };
      ports.push(port);
      return port;
    },
  };
}

function isStatusPost(message: unknown): boolean {
  return Boolean(message && typeof message === "object" && (message as { kind?: string }).kind === "status");
}

async function flush(): Promise<void> {
  for (let step = 0; step < 30; step += 1) await Promise.resolve();
}

describe("SyncController", () => {
  it("does not cycle an unlinked account or a manual interval", async () => {
    const unlinked = client();
    const clock = runtime();
    const events = listener();
    const controller = new SyncController("user-1", unlinked, clock, events);
    await controller.start();
    controller.nudge("focus");
    expect(unlinked.cycle).not.toHaveBeenCalled();
    const manual = client({ ...linked, intervalSeconds: 0 });
    const manualController = new SyncController("user-1", manual, runtime(), listener());
    await manualController.start();
    manualController.nudge("online");
    expect(manual.cycle).not.toHaveBeenCalled();
    expect(manual.status).toHaveBeenCalledTimes(2);
  });

  it("cycles on login when the interval is due and waits out server backoff", async () => {
    const api = client(linked);
    const events = listener();
    await new SyncController("user-1", api, runtime(), events).start();
    expect(api.cycle).toHaveBeenCalledTimes(1);
    const paused = client({ ...linked, backoffUntil: "2099-01-01T00:00:00.000Z" });
    await new SyncController("user-1", paused, runtime(), listener()).start();
    expect(paused.cycle).not.toHaveBeenCalled();
  });

  it("aborts an in-flight status read on stop and drops the stale body", async () => {
    let signal: AbortSignal | undefined;
    let resolveStatus: (status: SyncStatus) => void = () => undefined;
    const api = client();
    api.status = vi.fn((_signal: AbortSignal) => {
      signal = _signal;
      return new Promise<SyncStatus>((resolve) => { resolveStatus = resolve; });
    });
    const events = listener();
    const controller = new SyncController("user-1", api, runtime(), events);
    const pending = controller.start();
    controller.stop();
    resolveStatus(linked);
    await pending.catch(() => undefined);
    expect(signal?.aborted).toBe(true);
    expect(events.statuses).toEqual([null]);
  });

  it("stops after a 401 and shares one cycle across overlapping calls", async () => {
    const api = client(linked);
    let release: (status: SyncStatus) => void = () => undefined;
    api.cycle = vi.fn(() => new Promise<SyncStatus>((resolve) => { release = resolve; }));
    const controller = new SyncController("user-1", api, runtime(), listener());
    const first = controller.start();
    const second = controller.syncNow();
    await vi.waitFor(() => expect(api.cycle).toHaveBeenCalledTimes(1));
    release({ ...linked, result: "idle" });
    await first;
    await second;
    expect(api.cycle).toHaveBeenCalledTimes(1);

    api.cycle = vi.fn(async () => { throw new ApiError("Sign in to sync.", 401, "unauthorized", undefined); });
    const events = listener();
    const next = new SyncController("user-1", api, runtime(), events);
    await next.start();
    expect(events.statuses.at(-1)).toBeNull();
  });

  it("backs off sync_busy without a tight loop and skips a tab that does not hold the lock", async () => {
    const api = client(linked);
    api.cycle = vi.fn(async () => { throw new ApiError("busy", 409, "sync_busy", undefined); });
    const clock = runtime();
    const events = listener();
    await new SyncController("user-1", api, clock, events).start();
    expect(events.errors[0]).toBeInstanceOf(ApiError);
    expect(clock.delays.at(-1)).toBeGreaterThanOrEqual(15_000);
    expect(api.cycle).toHaveBeenCalledTimes(1);

    const locked = client(linked);
    const locks = { request: vi.fn(async (_name: string, _options: unknown, callback: (lock: unknown) => Promise<void>) => { await callback(null); }) };
    const lockedEvents = listener();
    const controller = new SyncController("user-1", locked, { ...runtime(), locks }, lockedEvents);
    await controller.start();
    await controller.syncNow();
    expect(locked.cycle).not.toHaveBeenCalled();
    expect(lockedEvents.errors[0]).toBeInstanceOf(SyncLocalBusyError);
  });

  it("emits a content-free data-changed event and ignores another user's channel message", async () => {
    const api = client(linked);
    api.cycle = vi.fn(async () => ({ ...linked, result: "bootstrap", phase: "linked", baseline: true }));
    const messages: unknown[] = [];
    const inbox: { current: ((data: unknown) => void) | null } = { current: null };
    const clock = runtime();
    clock.channel = () => ({
      postMessage: (data) => { messages.push(data); },
      close: () => undefined,
      onMessage: (handler) => { inbox.current = handler; },
    });
    const events = listener();
    const seen: unknown[] = [];
    window.addEventListener(SYNC_DATA_CHANGED, (event) => { seen.push((event as CustomEvent).detail); });
    const controller = new SyncController("user-1", api, clock, events);
    await controller.start();
    expect(events.changed).toEqual([{ userId: "user-1", identityId: "identity-1", result: "bootstrap", baseline: true, openConflicts: 0 }]);
    expect(JSON.stringify(messages)).not.toContain("pairing");
    expect(seen).toEqual(events.changed);
    const before = events.statuses.length;
    inbox.current?.({ userId: "user-2", kind: "status", status: { ...linked, identityId: "other" }, cycled: true });
    inbox.current?.({ userId: "user-1", kind: "data-changed", detail: { userId: "user-1", identityId: "identity-1", result: "published", baseline: true, openConflicts: 0 } });
    expect(events.statuses).toHaveLength(before);
    expect(events.changed).toHaveLength(2);
    controller.stop();
  });

  it("enables a new identity at two minutes and does not enable when create fails", async () => {
    const api = client();
    const controller = new SyncController("user-1", api, runtime(), listener());
    await controller.start();
    const code = await controller.createAndEnable();
    expect(code).toBe("ppss1.code");
    expect(api.configure).toHaveBeenCalledWith({ enabled: true, intervalSeconds: 120 }, expect.any(AbortSignal));
    expect(api.cycle).toHaveBeenCalledTimes(1);

    const rejected = client();
    rejected.create = vi.fn(async () => { throw new ApiError("conditional writes failed at proof", 422, "webdav_cas_unsupported", { step: "proof" }); });
    const failing = new SyncController("user-1", rejected, runtime(), listener());
    await failing.start();
    await expect(failing.createAndEnable()).rejects.toMatchObject({ code: "webdav_cas_unsupported" });
    expect(rejected.configure).not.toHaveBeenCalled();
    expect(rejected.cycle).not.toHaveBeenCalled();
  });

  it("requests an available lock without a signal, strips pairing data, and stops before configure", async () => {
    const api = client(linked);
    const seen: object[] = [];
    const locks = {
      request: async (_name: string, options: { ifAvailable?: boolean; signal?: AbortSignal }, callback: (lock: unknown) => Promise<void>) => {
        if ("signal" in options) throw new DOMException("NotSupportedError");
        seen.push(options);
        await callback({});
      },
    };
    await new SyncController("user-1", api, { ...runtime(), locks }, listener()).start();
    expect(seen[0]).toEqual({ ifAvailable: true });
    expect(api.cycle).toHaveBeenCalledTimes(1);

    let finish: (value: SyncStatus & { pairingCode: string }) => void = () => undefined;
    const creating = client();
    creating.create = vi.fn(() => new Promise<SyncStatus & { pairingCode: string }>((resolve) => { finish = resolve; }));
    const events = listener();
    const controller = new SyncController("user-2", creating, runtime(), events);
    await controller.start();
    const pending = controller.createAndEnable();
    controller.stop();
    finish({ ...linked, pairingCode: "ppss1.secret", editorGuard: false } as SyncStatus & { pairingCode: string });
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    expect(creating.configure).not.toHaveBeenCalled();
    expect(JSON.stringify(events.statuses)).not.toContain("pairingCode");
    expect(JSON.stringify(events.statuses)).not.toContain("ppss1.secret");
  });

  it("retries status without a cycle and does not run a timer after manual mode", async () => {
    const offline = client({ ...linked, linked: false, enabled: false, phase: "unlinked", baseline: false, identityId: null });
    let failed = false;
    offline.status = vi.fn(async () => {
      if (!failed) { failed = true; throw new Error("offline"); }
      return { ...linked, linked: false, enabled: false, phase: "unlinked", baseline: false, identityId: null };
    });
    const clock = runtime();
    await new SyncController("user-1", offline, clock, listener()).start();
    expect(offline.cycle).not.toHaveBeenCalled();
    expect(clock.delays[0]).toBeGreaterThanOrEqual(15_000);
    clock.fire();
    await vi.waitFor(() => expect(offline.status).toHaveBeenCalledTimes(2));
    expect(offline.cycle).not.toHaveBeenCalled();

    const api = client(linked);
    const timed = runtime();
    const controller = new SyncController("user-1", api, timed, listener());
    await controller.start();
    await controller.configure({ intervalSeconds: 0 });
    timed.fire();
    expect(api.cycle).toHaveBeenCalledTimes(1);
  });

  it("emits a refresh for idle only when dataChanged is true and drops pairing and unknown fields", async () => {
    const idle = { ...linked, result: "idle", dataChanged: false, pairingCode: "ppss1.secret", editorGuard: false, leaked: "nope" };
    const quietApi = client(linked);
    quietApi.cycle = vi.fn(async () => idle);
    const quiet = listener();
    await new SyncController("user-1", quietApi, runtime(), quiet).start();
    expect(quiet.changed).toEqual([]);
    expect(JSON.stringify(quiet.statuses)).not.toContain("ppss1.secret");
    expect(JSON.stringify(quiet.statuses)).not.toContain("editorGuard");
    expect(JSON.stringify(quiet.statuses)).not.toContain("leaked");

    const marked = client({ ...linked, intervalSeconds: 0 });
    marked.cycle = vi.fn(async () => ({ ...linked, result: "idle", dataChanged: true }));
    const events = listener();
    const manual = new SyncController("user-1", marked, runtime(), events);
    await manual.start();
    await manual.syncNow();
    expect(events.changed).toEqual([{ userId: "user-1", identityId: "identity-1", result: "idle", baseline: true, openConflicts: 0, dataChanged: true }]);

    const resolving = client({ ...linked, intervalSeconds: 0 });
    resolving.resolve = vi.fn(async () => ({ ...linked, result: "idle", dataChanged: false }));
    const held = listener();
    const chooser = new SyncController("user-1", resolving, runtime(), held);
    await chooser.start();
    await chooser.resolve("conflict-1", "keep-remote");
    expect(held.changed).toEqual([]);
    resolving.resolve = vi.fn(async () => ({ ...linked, result: "idle", dataChanged: true }));
    await chooser.resolve("conflict-1", "keep-remote");
    expect(held.changed).toHaveLength(1);
  });

  it("cycles after status recovery and resume on a fake clock without focus", async () => {
    let reads = 0;
    const api = client(linked);
    api.status = vi.fn(async () => {
      reads += 1;
      if (reads === 1) throw new Error("offline");
      return linked;
    });
    const clock = runtime();
    await new SyncController("user-1", api, clock, listener()).start();
    expect(api.cycle).not.toHaveBeenCalled();
    expect(clock.delays[0]).toBeGreaterThanOrEqual(15_000);
    clock.fire();
    await vi.waitFor(() => expect(api.cycle).toHaveBeenCalledTimes(1));

    const resume = client({ ...linked, enabled: false });
    resume.configure = vi.fn(async () => linked);
    const resumed = new SyncController("user-2", resume, runtime(), listener());
    await resumed.start();
    expect(resume.cycle).not.toHaveBeenCalled();
    await resumed.configure({ enabled: true });
    expect(resume.cycle).toHaveBeenCalledTimes(1);
  });

  it("follows bootstrap only after create or join, for eight fast cycles, then the normal interval", async () => {
    const partial: SyncStatus = { ...linked, phase: "bootstrap", baseline: false, result: "partial" };
    const capped = client();
    const cycle = vi.fn(async () => partial);
    capped.cycle = cycle;
    const capClock = runtime();
    const created = new SyncController("user-1", capped, capClock, listener());
    await created.start();
    expect(cycle).not.toHaveBeenCalled();
    await created.createAndEnable();
    expect(capped.create).toHaveBeenCalledTimes(1);
    expect(cycle).toHaveBeenCalledTimes(1);
    expect(capClock.delays.at(-1)).toBe(4_000);
    for (let count = cycle.mock.calls.length; count < 8; count = cycle.mock.calls.length) {
      expect(capClock.delays.at(-1)).toBe(4_000);
      expect(capClock.fireDue()).toBe(true);
      await vi.waitFor(() => expect(cycle.mock.calls.length).toBeGreaterThan(count));
    }
    expect(cycle).toHaveBeenCalledTimes(8);
    expect(capClock.delays.at(-1)).toBe(120_000);
    expect(capClock.fireDue()).toBe(true);
    await vi.waitFor(() => expect(cycle).toHaveBeenCalledTimes(9));
    expect(capClock.delays.at(-1)).toBe(120_000);

    const paused = client();
    paused.cycle = vi.fn(async () => partial);
    const kept: Array<() => void> = [];
    const pauseClock = runtime();
    const schedule = pauseClock.schedule.bind(pauseClock);
    pauseClock.schedule = (run, delay) => {
      kept.push(run);
      return schedule(run, delay);
    };
    const pauseController = new SyncController("user-2", paused, pauseClock, listener());
    await pauseController.start();
    await pauseController.createAndEnable();
    expect(paused.cycle).toHaveBeenCalledTimes(1);
    const stale = kept.at(-1)!;
    paused.configure = vi.fn(async () => ({ ...partial, enabled: false }));
    await pauseController.configure({ enabled: false });
    stale();
    await Promise.resolve();
    expect(paused.cycle).toHaveBeenCalledTimes(1);

    const manual = client();
    manual.cycle = vi.fn(async () => partial);
    const manualKept: Array<() => void> = [];
    const manualClock = runtime();
    const manualSchedule = manualClock.schedule.bind(manualClock);
    manualClock.schedule = (run, delay) => {
      manualKept.push(run);
      return manualSchedule(run, delay);
    };
    const manualController = new SyncController("user-3", manual, manualClock, listener());
    await manualController.start();
    await manualController.joinAndEnable("ppss1.code");
    expect(manual.join).toHaveBeenCalledWith("ppss1.code", expect.anything());
    expect(manual.cycle).toHaveBeenCalledTimes(1);
    const manualStale = manualKept.at(-1)!;
    manual.configure = vi.fn(async () => ({ ...partial, intervalSeconds: 0 }));
    await manualController.configure({ intervalSeconds: 0 });
    manualStale();
    await Promise.resolve();
    expect(manual.cycle).toHaveBeenCalledTimes(1);

    const backing = client();
    backing.cycle = vi.fn(async () => ({ ...partial, backoffUntil: "2099-01-01T00:00:00.000Z" }));
    const backClock = runtime();
    const backingController = new SyncController("user-4", backing, backClock, listener());
    await backingController.start();
    await backingController.createAndEnable();
    expect(backing.cycle).toHaveBeenCalledTimes(1);
    expect(backClock.delays.at(-1)).toBeGreaterThan(4_000);
    backClock.fire();
    await Promise.resolve();
    expect(backing.cycle).toHaveBeenCalledTimes(1);
  });

  it("refreshes peer status without adopting a stale message or echoing it", async () => {
    const posts: unknown[] = [];
    const bus = memoryChannels(posts);
    let server: SyncStatus = { ...linked };
    const apiFor = () => {
      const api = client(server);
      api.status = vi.fn(async () => ({ ...server }));
      api.configure = vi.fn(async (input: { enabled?: boolean; intervalSeconds?: number }) => {
        server = { ...server, ...input };
        return { ...server };
      });
      api.cycle = vi.fn(async () => ({ ...server, result: "idle" as const }));
      return api;
    };
    const leftApi = apiFor();
    const rightApi = apiFor();
    const leftEvents = listener();
    const leftClock = runtime();
    const rightClock = runtime();
    const left = new SyncController("user-1", leftApi, { ...leftClock, channel: bus.open }, leftEvents);
    const right = new SyncController("user-1", rightApi, { ...rightClock, channel: bus.open }, listener());
    await left.start();
    await right.start();
    await flush();
    const cyclesAfterStart = vi.mocked(leftApi.cycle).mock.calls.length;
    expect(cyclesAfterStart).toBe(1);

    await left.configure({ enabled: false });
    await flush();
    const staleEnabled = { userId: "user-1", kind: "status", status: { ...linked, enabled: true }, cycled: true };
    const statusReads = vi.mocked(leftApi.status).mock.calls.length;
    const statusPosts = posts.filter(isStatusPost).length;
    bus.ports[0]?.handler?.(staleEnabled);
    await flush();
    expect(leftEvents.statuses.at(-1)?.enabled).toBe(false);
    expect(server.enabled).toBe(false);
    expect(leftApi.cycle).toHaveBeenCalledTimes(cyclesAfterStart);
    expect(vi.mocked(leftApi.status).mock.calls.length).toBe(statusReads + 1);
    expect(posts.filter(isStatusPost).length).toBe(statusPosts);
    leftClock.fire();
    rightClock.fire();
    await flush();
    expect(leftApi.cycle).toHaveBeenCalledTimes(cyclesAfterStart);
    expect(vi.mocked(rightApi.cycle).mock.calls.length).toBe(1);

    let releaseRace: (status: SyncStatus) => void = () => undefined;
    leftApi.status = vi.fn(() => new Promise<SyncStatus>((resolve) => { releaseRace = resolve; }));
    bus.ports[0]?.handler?.(staleEnabled);
    await Promise.resolve();
    await left.configure({ enabled: false });
    releaseRace({ ...linked, enabled: true });
    await flush();
    expect(leftEvents.statuses.at(-1)?.enabled).toBe(false);
    expect(leftApi.cycle).toHaveBeenCalledTimes(cyclesAfterStart);

    let release: (status: SyncStatus) => void = () => undefined;
    leftApi.status = vi.fn(() => new Promise<SyncStatus>((resolve) => { release = resolve; }));
    bus.ports[0]?.handler?.(staleEnabled);
    bus.ports[0]?.handler?.(staleEnabled);
    bus.ports[0]?.handler?.(staleEnabled);
    const hanging = vi.mocked(leftApi.status).mock.calls.length;
    await Promise.resolve();
    left.stop();
    release({ ...linked, enabled: true });
    await flush();
    expect(hanging).toBe(1);
    expect(leftEvents.statuses.at(-1)).toBeNull();
    right.stop();
  });

  it("keeps a newer join when an older unlinked peer status arrives", async () => {
    const posts: unknown[] = [];
    const bus = memoryChannels(posts);
    let server: SyncStatus = { ...linked, linked: false, enabled: false, phase: "unlinked", identityId: null, baseline: false };
    const api = client(server);
    api.status = vi.fn(async () => ({ ...server }));
    api.join = vi.fn(async () => {
      server = { ...linked, enabled: false, phase: "bootstrap", baseline: false };
      return { ...server };
    });
    api.configure = vi.fn(async () => {
      server = { ...server, enabled: true, intervalSeconds: 120 };
      return { ...server };
    });
    api.cycle = vi.fn(async () => ({ ...server, phase: "linked", baseline: true, result: "idle" }));
    const peerApi = client(server);
    peerApi.status = vi.fn(async () => ({ ...server }));
    peerApi.cycle = vi.fn(async () => ({ ...server, result: "idle" as const }));
    const events = listener();
    const controller = new SyncController("user-1", api, { ...runtime(), channel: bus.open }, events);
    const peer = new SyncController("user-1", peerApi, { ...runtime(), channel: bus.open }, listener());
    await controller.start();
    await peer.start();
    await controller.joinAndEnable("ppss1.code");
    await flush();
    const cycles = vi.mocked(api.cycle).mock.calls.length;
    bus.ports[0]?.handler?.({
      userId: "user-1", kind: "status", cycled: false,
      status: { ...linked, linked: false, enabled: false, phase: "unlinked", identityId: null, baseline: false },
    });
    await flush();
    expect(events.statuses.at(-1)).toMatchObject({ linked: true, enabled: true, identityId: "identity-1" });
    expect(api.cycle).toHaveBeenCalledTimes(cycles);
    expect(JSON.stringify(posts)).not.toContain("pairing");
    controller.stop();
    peer.stop();
  });
});

describe("publicSyncStatus", () => {
  it("removes the temporary editor marker and keeps attachment text without binary fields", () => {
    const status = publicSyncStatus({ ...linked, editorGuard: false });
    expect(status).not.toHaveProperty("editorGuard");
    expect(attachmentSummary({ filename: "scan.pdf", content_type: "application/pdf", size: "12", content_sha256: "abc", bytes: "@@@", })).toEqual({ filename: "scan.pdf", type: "application/pdf", size: "12" });
    expect(conflictFieldEntries({ title: "Keep me", content: "Note body", user_id: "u", bytes: "@@@", settings: { minutes: 25 } }).map((field) => `${field.key}=${field.value}`)).toEqual(["title=Keep me", "content=Note body", "settings.minutes=25"]);
  });
});
