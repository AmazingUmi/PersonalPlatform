import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import {
  browserSyncRuntime, httpSyncClient, SESSION_ENDING_EVENT, SyncController,
  type SyncConflict, type SyncStatus,
} from "../shared/sync";
import { useAuth } from "./AuthContext";

export interface SyncContextValue {
  status: SyncStatus | null;
  loadError: Error | null;
  actionError: Error | null;
  busy: boolean;
  pairingCode: string | null;
  conflicts: SyncConflict[];
  conflictsError: Error | null;
  refresh(): Promise<void>;
  createIdentity(): Promise<void>;
  joinIdentity(pairingCode: string): Promise<void>;
  setEnabled(enabled: boolean): Promise<void>;
  setIntervalSeconds(intervalSeconds: 0 | 60 | 120): Promise<void>;
  syncNow(): Promise<void>;
  revealPairing(): Promise<void>;
  hidePairing(): void;
  unlink(): Promise<void>;
  reloadConflicts(): Promise<void>;
  resolveConflict(id: string, choice: "keep-local" | "keep-remote"): Promise<void>;
}

const SyncContext = createContext<SyncContextValue | null>(null);

const emptyConflicts: SyncConflict[] = [];

export function SyncProvider({ children }: { children: ReactNode }) {
  const { status: authStatus, user } = useAuth();
  const userId = authStatus === "authenticated" ? user?.id ?? null : null;
  const controllerRef = useRef<SyncController | null>(null);
  const ownerRef = useRef<string | null>(userId);
  ownerRef.current = userId;
  const [status, setStatus] = useState<SyncStatus | null>(null);
  const [loadError, setLoadError] = useState<Error | null>(null);
  const [actionError, setActionError] = useState<Error | null>(null);
  const [busy, setBusy] = useState(false);
  const [pairingCode, setPairingCode] = useState<string | null>(null);
  const [conflicts, setConflicts] = useState<SyncConflict[]>(emptyConflicts);
  const [conflictsError, setConflictsError] = useState<Error | null>(null);

  const clearSecrets = useCallback(() => {
    setPairingCode(null);
    setConflicts(emptyConflicts);
  }, []);

  useEffect(() => {
    controllerRef.current?.stop();
    controllerRef.current = null;
    setStatus(null);
    setLoadError(null);
    setActionError(null);
    setBusy(false);
    clearSecrets();
    if (!userId) return;
    let disposed = false;
    const controller = new SyncController(userId, httpSyncClient, browserSyncRuntime(), {
      onStatus: (next) => {
        if (disposed || controllerRef.current !== controller || ownerRef.current !== userId) return;
        setStatus(next);
        if (next) setLoadError(null);
      },
      onError: (error) => {
        if (disposed || controllerRef.current !== controller || ownerRef.current !== userId) return;
        const wrapped = error instanceof Error ? error : new Error("The operation failed. Please try again.");
        setActionError(wrapped);
        setLoadError((current) => current ?? wrapped);
      },
      onActivity: (active) => {
        if (!disposed && controllerRef.current === controller && ownerRef.current === userId) setBusy(active);
      },
      onDataChanged: () => { /* Apps observe SYNC_DATA_CHANGED. Drafts stay mounted. */ },
      onPeerStatus: () => undefined,
    });
    controllerRef.current = controller;
    void controller.start().catch(() => undefined);
    return () => {
      disposed = true;
      controller.stop();
      if (controllerRef.current === controller) controllerRef.current = null;
      clearSecrets();
    };
  }, [userId, clearSecrets]);

  useEffect(() => {
    const end = () => {
      controllerRef.current?.stop();
      controllerRef.current = null;
      setPairingCode(null);
      setBusy(false);
    };
    window.addEventListener(SESSION_ENDING_EVENT, end);
    return () => window.removeEventListener(SESSION_ENDING_EVENT, end);
  }, []);

  useEffect(() => {
    if (!userId || !controllerRef.current) return;
    const nudge = () => controllerRef.current?.nudge("focus");
    const onVisibility = () => { if (document.visibilityState === "visible") nudge(); };
    window.addEventListener("focus", nudge);
    window.addEventListener("online", nudge);
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      window.removeEventListener("focus", nudge);
      window.removeEventListener("online", nudge);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [userId]);

  const stillOwner = (controller: SyncController) => controllerRef.current === controller && ownerRef.current === controller.userId;

  const run = useCallback(async (action: (controller: SyncController) => Promise<void>) => {
    const controller = controllerRef.current;
    if (!controller) return;
    setActionError(null);
    try {
      await action(controller);
      if (!stillOwner(controller)) throw new DOMException("Aborted", "AbortError");
    }
    catch (error) {
      if (!stillOwner(controller) || error instanceof DOMException && error.name === "AbortError") return;
      setActionError(error instanceof Error ? error : new Error("The operation failed. Please try again."));
      throw error;
    }
  }, []);

  const reloadConflicts = useCallback(async () => {
    const controller = controllerRef.current;
    if (!controller) return;
    try {
      const items = await controller.conflicts();
      if (!stillOwner(controller)) return;
      setConflicts(items);
      setConflictsError(null);
    } catch (error) {
      if (!stillOwner(controller) || error instanceof DOMException && error.name === "AbortError") return;
      setConflictsError(error instanceof Error ? error : new Error("The operation failed. Please try again."));
    }
  }, []);

  useEffect(() => {
    if (!userId || !status?.linked || status.openConflicts === 0) {
      if (!status?.openConflicts) setConflicts(emptyConflicts);
      return;
    }
    void reloadConflicts();
  }, [userId, status?.linked, status?.openConflicts, status?.result, reloadConflicts]);

  const value = useMemo<SyncContextValue>(() => ({
    status, loadError, actionError, busy, pairingCode, conflicts, conflictsError,
    refresh: () => run(async (controller) => { await controller.refresh(); }),
    createIdentity: () => run(async (controller) => {
      const code = await controller.createAndEnable();
      if (stillOwner(controller)) setPairingCode(code);
    }),
    joinIdentity: (code: string) => run(async (controller) => { await controller.joinAndEnable(code); }),
    setEnabled: (enabled: boolean) => run(async (controller) => { await controller.configure({ enabled }); }),
    setIntervalSeconds: (intervalSeconds: 0 | 60 | 120) => run(async (controller) => { await controller.configure({ intervalSeconds }); }),
    syncNow: () => run(async (controller) => { await controller.syncNow(); }),
    revealPairing: () => run(async (controller) => {
      const code = await controller.reveal();
      if (stillOwner(controller)) setPairingCode(code);
    }),
    hidePairing: () => setPairingCode(null),
    unlink: () => run(async (controller) => {
      await controller.unlink();
      if (!stillOwner(controller)) return;
      setPairingCode(null);
      setConflicts(emptyConflicts);
    }),
    reloadConflicts,
    resolveConflict: (id, choice) => run(async (controller) => {
      await controller.resolve(id, choice);
      if (stillOwner(controller)) await reloadConflicts();
    }),
  }), [status, loadError, actionError, busy, pairingCode, conflicts, conflictsError, run, reloadConflicts]);

  return <SyncContext.Provider value={value}>{children}</SyncContext.Provider>;
}

export function useSync(): SyncContextValue {
  const value = useContext(SyncContext);
  if (!value) throw new Error("useSync must be used inside <SyncProvider>");
  return value;
}
