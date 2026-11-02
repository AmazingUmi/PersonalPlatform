import { createElement, useEffect, useRef, useState } from "react";
import { useOptionalAuth } from "../shell/AuthContext";
import { ApiError } from "./api";
import { useI18n } from "./i18n";
import { SYNC_DATA_CHANGED, type SyncDataChangedDetail } from "./sync";
import { PixelButton } from "./ui/PixelButton";
import { StatusMessage } from "./ui/StatusMessage";

/** Hash captured when the editor loaded. Background refresh must not replace it while the form is dirty. */
export function loadedBaseHash(value: { baseHash?: string | null } | null | undefined): string | undefined {
  return typeof value?.baseHash === "string" && value.baseHash.length > 0 ? value.baseHash : undefined;
}

/** Dirty editors keep the hash they loaded, including a missing hash. A clean model takes the refresh. */
export function retainLoadedHash(
  loaded: string | undefined,
  incoming: string | undefined,
  dirty: boolean,
): string | undefined {
  if (dirty) return loaded;
  return incoming ?? loaded;
}

export function withBaseHash<T extends object>(body: T, baseHash: string | undefined): T & { baseHash?: string } {
  return baseHash === undefined ? body : { ...body, baseHash };
}

export function baseHashHeaders(baseHash: string | undefined, headers?: HeadersInit): HeadersInit | undefined {
  if (baseHash === undefined) return headers;
  const next = new Headers(headers);
  next.set("x-base-hash", baseHash);
  return next;
}

export function isSyncConflict(error: unknown): boolean {
  return error instanceof ApiError && (error.code === "sync_stale" || error.code === "sync_base_required");
}

/** Arm the pending-review notice for fence 409s only. Other errors stay ordinary. */
export function armPendingIfSyncConflict(error: unknown, markPending: () => void): void {
  if (isSyncConflict(error)) markPending();
}

/**
 * Refresh clean models for this signed-in user only.
 * Dirty editors keep their draft and report the event instead of remounting.
 */
export function subscribeOwnDataChanged(
  userId: string | null,
  onClean: () => void,
  onDirty: () => void,
  dirty: () => boolean,
): () => void {
  if (typeof window === "undefined" || userId === null) return () => undefined;
  const handler = (event: Event) => {
    const detail = (event as CustomEvent<SyncDataChangedDetail>).detail;
    if (!detail || detail.userId !== userId) return;
    if (dirty()) onDirty();
    else onClean();
  };
  window.addEventListener(SYNC_DATA_CHANGED, handler);
  return () => window.removeEventListener(SYNC_DATA_CHANGED, handler);
}

function useOptionalUserId(): string | null {
  return useOptionalAuth()?.user?.id ?? null;
}

/**
 * Apply a fetched record and its hash together.
 * The first observation matches the initial state. A later observation applies
 * only while the draft is still clean, or when the user asked to discard it.
 * A dirty draft keeps its current fields and hash and becomes stale.
 */
export function useCoherentDraft<T>(
  incoming: T | null,
  signature: string | null,
  dirty: boolean,
  apply: (incoming: T) => void,
  onAdopted?: () => void,
): { stale: boolean; requestAdopt: () => void; cancelAdopt: () => void } {
  const dirtyRef = useRef(dirty);
  const applyRef = useRef(apply);
  const onAdoptedRef = useRef(onAdopted);
  const adoptNext = useRef(false);
  const seen = useRef<string | null>(null);
  const [stale, setStale] = useState(false);
  dirtyRef.current = dirty;
  applyRef.current = apply;
  onAdoptedRef.current = onAdopted;
  useEffect(() => {
    if (incoming == null || signature == null) return;
    if (seen.current === signature && !adoptNext.current) return;
    const first = seen.current === null;
    seen.current = signature;
    if (first && !adoptNext.current) return;
    if (adoptNext.current || !dirtyRef.current) {
      adoptNext.current = false;
      applyRef.current(incoming);
      setStale(false);
      onAdoptedRef.current?.();
      return;
    }
    setStale(true);
  }, [incoming, signature]);
  return {
    stale,
    requestAdopt() { adoptNext.current = true; },
    cancelAdopt() { adoptNext.current = false; },
  };
}

/**
 * Own-user sync events refresh a clean model in place.
 * A dirty editor keeps its draft and hash and surfaces a reload action.
 */
export function useSyncModelRefresh(
  dirty: boolean,
  onClean: () => void,
  explicitUserId?: string | null,
): { pending: boolean; reload: () => void; dismiss: () => void; markPending: () => void } {
  const signedIn = useOptionalUserId();
  const userId = explicitUserId === undefined ? signedIn : explicitUserId;
  const [pending, setPending] = useState(false);
  const dirtyRef = useRef(dirty);
  const onCleanRef = useRef(onClean);
  dirtyRef.current = dirty;
  onCleanRef.current = onClean;
  useEffect(() => subscribeOwnDataChanged(
    userId,
    () => {
      setPending(false);
      onCleanRef.current();
    },
    () => setPending(true),
    () => dirtyRef.current,
  ), [userId]);
  return {
    pending,
    /** Clear the notice without fetching. */
    dismiss() {
      setPending(false);
    },
    markPending() {
      setPending(true);
    },
    reload() {
      setPending(false);
      onCleanRef.current();
    },
  };
}

export function SyncPendingNotice({
  pending,
  onReload,
  discard = false,
}: {
  pending: boolean;
  onReload: () => void;
  discard?: boolean;
}) {
  const { t } = useI18n();
  if (!pending) return null;
  return createElement(StatusMessage, {
    tone: "warning",
    children: createElement(
      "div",
      null,
      createElement("p", null, t(
        "Server data changed. Your unsaved edits are kept.",
        "服务器数据已更改。未保存的修改已保留。",
      )),
      createElement(PixelButton, {
        size: "sm",
        variant: "secondary",
        type: "button",
        onClick: onReload,
        children: discard
          ? t("Discard draft and reload", "放弃草稿并重新加载")
          : t("Reload server data", "重新加载服务器数据"),
      }),
    ),
  });
}
