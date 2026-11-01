import { afterEach, describe, expect, it, vi } from "vitest";
import { exportData, MAX_SNAPSHOT_BYTES, parseBackup } from "./dataManagement";
import { UNAUTHORIZED_EVENT } from "./api";

describe("backup download boundaries", () => {
  afterEach(() => { vi.unstubAllGlobals(); });

  it("signals expired sessions and preserves the server error", async () => {
    const unauthorized = vi.fn();
    window.addEventListener(UNAUTHORIZED_EVENT, unauthorized);
    try {
      vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({ error: { code: "unauthorized", message: "Sign in again." } }), { status: 401 })));
      await expect(exportData("own")).rejects.toMatchObject({ message: "Sign in again.", status: 401, code: "unauthorized" });
      expect(unauthorized).toHaveBeenCalledTimes(1);
    } finally { window.removeEventListener(UNAUTHORIZED_EVENT, unauthorized); }
  });

  it("refuses a declared oversized download before reading it", async () => {
    const cancel = vi.fn();
    const stream = new ReadableStream({ cancel });
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(stream, { headers: { "content-length": String(MAX_SNAPSHOT_BYTES + 1) } })));
    await expect(exportData("own")).rejects.toThrow("32 MiB");
    expect(cancel).toHaveBeenCalledTimes(1);
  });

  it("enforces the limit even without a content-length header", async () => {
    const stream = new ReadableStream({ start(controller) { controller.enqueue(new Uint8Array(MAX_SNAPSHOT_BYTES + 1)); controller.close(); } });
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(stream)));
    await expect(exportData("own")).rejects.toThrow("32 MiB");
  });

  it("uses a safe filename for download headers containing paths", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("{}", { headers: { "content-disposition": 'attachment; filename="../../private.json"' } })));
    const result = await exportData("all");
    expect(result.filename).toBe("personal-platform-backup.json");
    expect(result.blob.size).toBe(2);
    expect(fetch).toHaveBeenCalledWith("/api/core/data/export?scope=all");
  });

  it("rejects non-object JSON with an actionable format error", async () => {
    await expect(parseBackup({ size: 4, text: async () => "null" } as Blob)).rejects.toThrow("valid Settings JSON backup");
  });
});
