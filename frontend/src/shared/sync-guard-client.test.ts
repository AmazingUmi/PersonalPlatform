import { describe, expect, it, vi } from "vitest";
import { ApiError } from "./api";
import { SYNC_DATA_CHANGED } from "./sync";
import { armPendingIfSyncConflict, isSyncConflict, loadedBaseHash, retainLoadedHash, subscribeOwnDataChanged, withBaseHash } from "./sync-guard-client";

describe("sync guard client", () => {
  it("keeps the loaded hash and ignores another user's event", () => {
    const original = loadedBaseHash({ baseHash: "a".repeat(64) });
    expect(withBaseHash({ title: "draft" }, original).baseHash).toBe(original);
    const clean = vi.fn();
    const dirty = vi.fn();
    const stop = subscribeOwnDataChanged("user-1", clean, dirty, () => true);
    window.dispatchEvent(new CustomEvent(SYNC_DATA_CHANGED, { detail: { userId: "user-2", result: "committed", identityId: null, baseline: true, openConflicts: 0 } }));
    window.dispatchEvent(new CustomEvent(SYNC_DATA_CHANGED, { detail: { userId: "user-1", result: "committed", identityId: null, baseline: true, openConflicts: 0 } }));
    expect(clean).not.toHaveBeenCalled();
    expect(dirty).toHaveBeenCalledTimes(1);
    stop();
  });

  it("keeps a dirty draft hash while a clean model takes the refresh", () => {
    const loaded = "a".repeat(64);
    const incoming = "b".repeat(64);
    expect(retainLoadedHash(loaded, incoming, true)).toBe(loaded);
    expect(retainLoadedHash(undefined, incoming, true)).toBeUndefined();
    expect(withBaseHash({ title: "draft" }, retainLoadedHash(loaded, incoming, true)).baseHash).toBe(loaded);
    expect(withBaseHash({ title: "legacy" }, retainLoadedHash(undefined, incoming, true)).baseHash).toBeUndefined();
    expect(retainLoadedHash(loaded, incoming, false)).toBe(incoming);
    const clean = vi.fn();
    const dirty = vi.fn();
    const stop = subscribeOwnDataChanged("user-1", clean, dirty, () => false);
    window.dispatchEvent(new CustomEvent(SYNC_DATA_CHANGED, {
      detail: { userId: "user-1", identityId: "id-1", result: "committed", baseline: false, openConflicts: 0 },
    }));
    expect(clean).toHaveBeenCalledTimes(1);
    expect(dirty).not.toHaveBeenCalled();
    stop();
  });

  it("recognizes fence conflicts without treating other 409s as sync", () => {
    expect(isSyncConflict(new ApiError("stale", 409, "sync_stale", null))).toBe(true);
    expect(isSyncConflict(new ApiError("required", 409, "sync_base_required", null))).toBe(true);
    expect(isSyncConflict(new ApiError("revision", 409, "revision_conflict", null))).toBe(false);
    const mark = vi.fn();
    armPendingIfSyncConflict(new ApiError("stale", 409, "sync_stale", null), mark);
    armPendingIfSyncConflict(new ApiError("required", 409, "sync_base_required", null), mark);
    armPendingIfSyncConflict(new ApiError("revision", 409, "revision_conflict", null), mark);
    armPendingIfSyncConflict(new Error("plain"), mark);
    expect(mark).toHaveBeenCalledTimes(2);
  });
});
