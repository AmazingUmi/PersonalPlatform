import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MemoryRouter } from "react-router-dom";
import { ApiError } from "../shared/api";
import { I18nProvider, useI18n } from "../shared/i18n";
import { httpSyncClient, type SyncConflict, type SyncStatus } from "../shared/sync";
import { AuthProvider } from "./AuthContext";
import { SyncPanel } from "./SyncPanel";
import { SyncProvider } from "./SyncContext";

vi.mock("../shared/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../shared/api")>();
  return { ...actual, fetchMe: vi.fn(), logout: vi.fn() };
});

import { fetchMe as fetchMeMock } from "../shared/api";

const unlinked: SyncStatus = {
  linked: false, enabled: false, phase: "unlinked", intervalSeconds: 120, identityId: null,
  openConflicts: 0, lastError: null, backoffUntil: null, baseline: false, pending: false,
};
const linked: SyncStatus = {
  linked: true, enabled: true, phase: "linked", intervalSeconds: 120, identityId: "identity-1",
  openConflicts: 1, lastError: null, backoffUntil: null, baseline: true, pending: false, result: "conflicted",
};
const deleted: SyncConflict = {
  id: "conflict-1", syncKey: "notes.notes:[\"note-1\"]", reason: "tombstone",
  local: { title: "Local note", content: "Kept on this device" }, remote: null, baseHash: null,
};
const restored: SyncConflict = {
  id: "conflict-2", syncKey: "tasks.tasks:[\"task-1\"]", reason: "deleted-locally",
  local: null, remote: { title: "Cloud task" }, baseHash: null,
};

function LanguageSwitch() {
  const { language, setLanguage } = useI18n();
  return <button onClick={() => setLanguage(language === "zh" ? "en" : "zh")}>Switch language</button>;
}

function renderPanel(configured = true) {
  return render(<I18nProvider><AuthProvider><SyncProvider><MemoryRouter initialEntries={["/settings?section=webdav&view=sync"]}>
    <SyncPanel configured={configured} connectionLoading={false} /><LanguageSwitch />
  </MemoryRouter></SyncProvider></AuthProvider></I18nProvider>);
}

beforeEach(() => {
  vi.mocked(fetchMeMock).mockResolvedValue({ id: "user-1", username: "ada", displayName: null, role: "user" });
  vi.spyOn(httpSyncClient, "status").mockResolvedValue(unlinked);
  vi.spyOn(httpSyncClient, "create").mockResolvedValue({ ...linked, phase: "bootstrap", baseline: false, enabled: false, pairingCode: "ppss1.secret" });
  vi.spyOn(httpSyncClient, "join").mockResolvedValue({ ...linked, phase: "bootstrap", baseline: false, enabled: false });
  vi.spyOn(httpSyncClient, "configure").mockResolvedValue({ ...linked, phase: "bootstrap", baseline: false, enabled: true, result: undefined });
  vi.spyOn(httpSyncClient, "cycle").mockResolvedValue({ ...linked, phase: "bootstrap", baseline: false, openConflicts: 0, result: "partial" });
  vi.spyOn(httpSyncClient, "conflicts").mockResolvedValue({ items: [] });
  vi.spyOn(httpSyncClient, "reveal").mockResolvedValue({ pairingCode: "ppss1.secret" });
  vi.spyOn(httpSyncClient, "unlink").mockResolvedValue(undefined);
  vi.spyOn(httpSyncClient, "resolve").mockResolvedValue(linked);
});

afterEach(() => { cleanup(); vi.restoreAllMocks(); });

describe("Sync settings view", () => {
  it("explains a missing connection and does not sync before an explicit choice", async () => {
    renderPanel(false);
    expect(await screen.findByText(/Save a WebDAV connection first/)).toBeVisible();
    expect(screen.getByRole("link", { name: "Open connection" })).toHaveAttribute("href", "/settings?section=webdav&view=connection");
    expect(httpSyncClient.cycle).not.toHaveBeenCalled();
    cleanup();
    renderPanel(true);
    expect(await screen.findByRole("button", { name: "Create cloud sync identity" })).toBeVisible();
    expect(screen.getByRole("heading", { name: "Continuous sync" }).parentElement).toContainElement(screen.getByRole("button", { name: "Help: About continuous sync" }));
    await waitFor(() => expect(httpSyncClient.status).toHaveBeenCalled());
    expect(httpSyncClient.cycle).not.toHaveBeenCalled();
    expect(httpSyncClient.create).not.toHaveBeenCalled();
  });

  it("creates an identity, shows the code, and surfaces a conditional-write failure", async () => {
    const clipboard = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText: clipboard } });
    renderPanel();
    fireEvent.click(await screen.findByRole("button", { name: "Create cloud sync identity" }));
    expect(await screen.findByText("The link is saved. The first sync has not finished, so cloud data is not shown as present yet.")).toBeVisible();
    expect(httpSyncClient.configure).toHaveBeenCalledWith({ enabled: true, intervalSeconds: 120 }, expect.any(AbortSignal));
    expect(httpSyncClient.cycle).toHaveBeenCalledTimes(1);
    expect(screen.getByLabelText("Pairing code")).toHaveValue("ppss1.secret");
    fireEvent.click(screen.getByRole("button", { name: "Copy pairing code" }));
    await screen.findByText("Pairing code copied.");
    expect(clipboard).toHaveBeenCalledWith("ppss1.secret");
    fireEvent.click(screen.getByRole("button", { name: "Hide pairing code" }));
    expect(screen.queryByDisplayValue("ppss1.secret")).not.toBeInTheDocument();

    cleanup();
    vi.mocked(httpSyncClient.create).mockRejectedValue(new ApiError("WebDAV conditional writes failed at proof.", 422, "webdav_cas_unsupported", { step: "proof" }));
    vi.mocked(httpSyncClient.status).mockResolvedValue(unlinked);
    const configuredCalls = vi.mocked(httpSyncClient.configure).mock.calls.length;
    renderPanel();
    fireEvent.click(await screen.findByRole("button", { name: "Create cloud sync identity" }));
    expect(await screen.findByText(/cannot safely store sync data/)).toBeVisible();
    expect(screen.getByText(/proof/)).toBeVisible();
    expect(vi.mocked(httpSyncClient.configure).mock.calls.length).toBe(configuredCalls);
  });

  it("shows a deleted side, keeps the conflict when the choice fails, and copies with a visible fallback", async () => {
    vi.mocked(httpSyncClient.status).mockResolvedValue(linked);
    vi.mocked(httpSyncClient.cycle).mockResolvedValue(linked);
    vi.mocked(httpSyncClient.conflicts).mockResolvedValue({ items: [deleted, restored] });
    vi.mocked(httpSyncClient.resolve).mockRejectedValue(new ApiError("The local record changed. Review it again before choosing a version.", 409, "sync_stale", undefined));
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText: vi.fn().mockRejectedValue(new Error("denied")) } });
    renderPanel();
    expect(await screen.findByText("Local note")).toBeVisible();
    expect(screen.getByText("Kept on this device")).toBeVisible();
    expect(screen.getByText("Deleted in the cloud")).toBeVisible();
    expect(screen.getByText("Deleted on this device")).toBeVisible();
    expect(screen.getByRole("button", { name: "Accept cloud deletion" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "Accept deletion on this device" })).toBeEnabled();
    fireEvent.click(screen.getByRole("button", { name: "Accept cloud deletion" }));
    expect(await screen.findByText(/The record changed before the choice was saved/)).toBeVisible();
    expect(screen.getByText("Local note")).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Keep this device" }));
    expect(screen.getByText("Local note")).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Show pairing code" }));
    await screen.findByDisplayValue("ppss1.secret");
    fireEvent.click(screen.getByRole("button", { name: "Copy pairing code" }));
    expect(await screen.findByText(/Select the code above/)).toBeVisible();
  });

  it("does not repeat link requests when the language changes", async () => {
    renderPanel();
    await screen.findByRole("button", { name: "Create cloud sync identity" });
    const before = vi.mocked(httpSyncClient.status).mock.calls.length;
    fireEvent.click(screen.getByRole("button", { name: "Switch language" }));
    expect(screen.getByRole("button", { name: "创建云端同步身份" })).toBeVisible();
    expect(screen.getByRole("heading", { name: "持续同步" }).parentElement).toContainElement(screen.getByRole("button", { name: "帮助：关于持续同步" }));
    expect(vi.mocked(httpSyncClient.status).mock.calls.length).toBe(before);
    expect(httpSyncClient.create).not.toHaveBeenCalled();
    expect(httpSyncClient.cycle).not.toHaveBeenCalled();
  });
});
