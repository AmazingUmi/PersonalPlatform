import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DataManagementPanel } from "./DataManagementPanel";
import * as data from "../shared/dataManagement";

let role = "admin";
vi.mock("./AuthContext", () => ({ useAuth: () => ({ user: { id: "user-1", role } }) }));
vi.mock("../shared/dataManagement", async (original) => ({
  ...await original<typeof import("../shared/dataManagement")>(),
  getWebDav: vi.fn(), getBackupHistory: vi.fn(), saveWebDav: vi.fn(), deleteWebDav: vi.fn(),
  testWebDav: vi.fn(), backupWebDav: vi.fn(), exportData: vi.fn(), saveDownload: vi.fn(),
  previewMerge: vi.fn(), importSnapshot: vi.fn(), downloadBackup: vi.fn(),
}));
const config: data.WebDavConfig = {
  configured: true, endpoint: "https://drive.example.com/backup/", username: "backup-user", hasPassword: true,
  scope: "own", intervalHours: 24, nextRunAt: "2026-11-02T12:00:00.000Z", lastRunAt: null, lastStatus: null, lastError: null,
};
const report: data.MergeReport = {
  scope: "own", createdAt: "2026-11-01T12:00:00.000Z", files: 1, inserted: 2, skipped: 3,
  tables: [{ table: "tasks.tasks", inserted: 2, skipped: 3, conflicts: 0 }],
};
const backup: data.BackupRecord = {
  id: "backup-id", filename: "historical.json", scope: "own", createdAt: report.createdAt,
  size: 4096, available: true, kind: "incremental", uploadedBytes: 256, uploadedObjects: 2,
};
function chooseFile(payload: unknown = { type: "personal-platform-data", scope: "own" }) {
  const file = new File([JSON.stringify(payload)], "previous-backup.json", { type: "application/json" });
  Object.defineProperty(file, "text", { value: () => Promise.resolve(JSON.stringify(payload)) });
  fireEvent.change(screen.getByLabelText("Backup file"), { target: { files: [file] } });
}
async function ready() {
  render(<DataManagementPanel />);
  await screen.findByDisplayValue(config.endpoint);
}

describe("Settings data management", () => {
  beforeEach(() => {
    role = "admin";
    vi.mocked(data.getWebDav).mockResolvedValue({ ...config });
    vi.mocked(data.getBackupHistory).mockResolvedValue({ items: [] });
    vi.mocked(data.previewMerge).mockResolvedValue({ ...report });
    vi.mocked(data.importSnapshot).mockResolvedValue({ ...report });
  });
  afterEach(() => { cleanup(); vi.resetAllMocks(); });

  it("offers all-user scope to administrators, and only own scope to ordinary users", async () => {
    role = "user";
    await ready();
    expect(within(screen.getByLabelText("Data scope")).getAllByRole("option")).toHaveLength(1);
    expect(within(screen.getByLabelText("Backup scope")).getAllByRole("option")).toHaveLength(1);
    expect(screen.queryByText("All users (administrator)")).not.toBeInTheDocument();
  });

  it("exports the chosen all-user scope and shows the sensitive-account warning", async () => {
    vi.mocked(data.exportData).mockResolvedValue({ blob: new Blob(["{}"]), filename: "all.json" });
    await ready();
    fireEvent.change(screen.getByLabelText("Data scope"), { target: { value: "all" } });
    expect(screen.getByText(/account password hashes. Store it privately/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Export backup" }));
    await waitFor(() => expect(data.exportData).toHaveBeenCalledWith("all"));
    await waitFor(() => expect(data.saveDownload).toHaveBeenCalledTimes(1));
  });

  it("requires a successful preview before a deliberate merge and reports preserved rows", async () => {
    await ready();
    chooseFile();
    await screen.findByText("Selected: previous-backup.json");
    expect(screen.queryByRole("button", { name: "Merge missing data" })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Preview merge" }));
    await screen.findByTestId("merge-preview");
    expect(screen.getByText("Preview: 2 to add, 3 to keep. Counts are checked again when you merge.")).toBeInTheDocument();
    expect(data.importSnapshot).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Merge missing data" }));
    await screen.findByText(/Merge complete: 2 added, 3 existing records kept/);
    expect(data.importSnapshot).toHaveBeenCalledWith("own", expect.objectContaining({ scope: "own" }));
    expect(screen.queryByTestId("merge-preview")).not.toBeInTheDocument();
  });

  it("clears the prior preview when import scope changes", async () => {
    await ready(); chooseFile();
    await screen.findByText("Selected: previous-backup.json");
    fireEvent.click(screen.getByRole("button", { name: "Preview merge" }));
    await screen.findByTestId("merge-preview");
    fireEvent.change(screen.getByLabelText("Data scope"), { target: { value: "all" } });
    expect(screen.queryByTestId("merge-preview")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Preview merge" })).toBeDisabled();
  });

  it("shows server-side preview conflicts and does not enable import", async () => {
    vi.mocked(data.previewMerge).mockRejectedValue(new Error("A record belongs to another user."));
    await ready(); chooseFile();
    await screen.findByText("Selected: previous-backup.json");
    fireEvent.click(screen.getByRole("button", { name: "Preview merge" }));
    await screen.findByText("A record belongs to another user.");
    expect(screen.queryByRole("button", { name: "Merge missing data" })).not.toBeInTheDocument();
    expect(data.importSnapshot).not.toHaveBeenCalled();
  });

  it("rejects oversized files before reading or sending them", async () => {
    await ready();
    const text = vi.fn();
    fireEvent.change(screen.getByLabelText("Backup file"), { target: { files: [{ name: "huge.json", size: data.MAX_SNAPSHOT_BYTES + 1, text }] } });
    await screen.findByText("The backup exceeds the 32 MiB limit.");
    expect(text).not.toHaveBeenCalled();
    expect(data.previewMerge).not.toHaveBeenCalled();
  });

  it("preserves a saved password when changing the automatic interval and blocks unsaved actions", async () => {
    vi.mocked(data.saveWebDav).mockResolvedValue({ ...config, intervalHours: 6 });
    await ready();
    expect(screen.getByLabelText("WebDAV password or app token")).toHaveValue("");
    fireEvent.change(screen.getByLabelText("Automatic backup"), { target: { value: "6" } });
    expect(screen.getByRole("button", { name: "Back up now" })).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "Save backup settings" }));
    await screen.findByText("Backup settings saved.");
    expect(data.saveWebDav).toHaveBeenCalledWith({ endpoint: config.endpoint, username: config.username, scope: "own", intervalHours: 6 });
    expect(screen.getByRole("button", { name: "Back up now" })).toBeEnabled();
    expect(screen.getByLabelText("WebDAV password or app token")).toHaveValue("");
  });

  it("requires new credentials when changing the destination and clears them after saving", async () => {
    vi.mocked(data.saveWebDav).mockResolvedValue({ ...config, endpoint: "https://other.example/" });
    await ready();
    fireEvent.change(screen.getByLabelText("WebDAV folder URL"), { target: { value: "https://other.example/" } });
    expect(screen.getByLabelText("WebDAV password or app token")).toBeRequired();
    fireEvent.change(screen.getByLabelText("WebDAV password or app token"), { target: { value: "private-token" } });
    fireEvent.click(screen.getByRole("button", { name: "Save backup settings" }));
    await screen.findByText("Backup settings saved.");
    expect(data.saveWebDav).toHaveBeenCalledWith(expect.objectContaining({ password: "private-token" }));
    expect(screen.getByLabelText("WebDAV password or app token")).toHaveValue("");
  });

  it("shows backup failures without claiming success", async () => {
    vi.mocked(data.backupWebDav).mockRejectedValue(new Error("WebDAV authentication failed."));
    await ready();
    fireEvent.click(screen.getByRole("button", { name: "Back up now" }));
    await screen.findByText("WebDAV authentication failed.");
    expect(screen.queryByText(/Backup saved:/)).not.toBeInTheDocument();
  });

  it("defaults manual WebDAV to incremental and shows the actual uploaded amount", async () => {
    vi.mocked(data.backupWebDav).mockResolvedValue({ status: "created", backup, uploadedBytes: 256, uploadedObjects: 2 });
    await ready();
    expect(screen.getByLabelText("Manual backup mode")).toHaveValue("incremental");
    fireEvent.click(screen.getByRole("button", { name: "Back up now" }));
    await screen.findByText(/Backup saved: historical.json. Uploaded 0.3 KiB in 2 object/);
    expect(data.backupWebDav).toHaveBeenCalledWith("incremental");
  });

  it("lets a user choose a full WebDAV backup without changing the automatic schedule", async () => {
    vi.mocked(data.backupWebDav).mockResolvedValue({ status: "created", backup: { ...backup, kind: "full" }, uploadedBytes: 4096, uploadedObjects: 1 });
    await ready();
    fireEvent.change(screen.getByLabelText("Manual backup mode"), { target: { value: "full" } });
    fireEvent.click(screen.getByRole("button", { name: "Back up now" }));
    await screen.findByText(/Uploaded 4.0 KiB in 1 object/);
    expect(data.backupWebDav).toHaveBeenCalledWith("full");
    expect(data.saveWebDav).not.toHaveBeenCalled();
    expect(screen.getByLabelText("Automatic backup")).toHaveValue("24");
  });

  it("reports no changes without inventing another backup entry", async () => {
    vi.mocked(data.backupWebDav).mockResolvedValue({ status: "unchanged", backup: null, uploadedBytes: 0, uploadedObjects: 0 });
    await ready();
    fireEvent.click(screen.getByRole("button", { name: "Back up now" }));
    await screen.findByText("Data is unchanged. Nothing was uploaded and no new backup was created.");
    expect(screen.getByText("No backups recorded yet.")).toBeInTheDocument();
    expect(screen.queryByText(/Backup saved:/)).not.toBeInTheDocument();
  });

  it("distinguishes repaired remote objects from a zero-upload unchanged result", async () => {
    vi.mocked(data.backupWebDav).mockResolvedValue({ status: "unchanged", backup: null, uploadedBytes: 2048, uploadedObjects: 1 });
    await ready();
    fireEvent.click(screen.getByRole("button", { name: "Back up now" }));
    await screen.findByText("Data is unchanged. Repaired 1 missing object(s), uploading 2.0 KiB. No new backup was created.");
    expect(screen.queryByText(/Nothing was uploaded/)).not.toBeInTheDocument();
  });

  it("requires confirmation to remove a connection and disables subsequent backups", async () => {
    vi.mocked(data.deleteWebDav).mockResolvedValue(undefined);
    await ready();
    fireEvent.click(screen.getByRole("button", { name: "Remove connection" }));
    expect(data.deleteWebDav).not.toHaveBeenCalled();
    vi.mocked(data.getWebDav).mockResolvedValue({ ...config, configured: false, endpoint: "", username: "", hasPassword: false, intervalHours: 0 });
    fireEvent.click(screen.getByRole("button", { name: "Confirm remove connection" }));
    await screen.findByText("Connection removed. Automatic backups are off.");
    expect(data.deleteWebDav).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("button", { name: "Back up now" })).not.toBeInTheDocument();
  });

  it("loads a recorded remote backup into the same preview flow", async () => {
    const record: data.BackupRecord = backup;
    vi.mocked(data.getBackupHistory).mockResolvedValue({ items: [record] });
    const blob = new Blob(["{}"]);
    Object.defineProperty(blob, "text", { value: async () => "{}" });
    vi.mocked(data.downloadBackup).mockResolvedValue({ blob, filename: record.filename });
    await ready();
    expect(screen.getByText(/Incremental · My data.*Full data 4.0 KiB · Uploaded 0.3 KiB/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Review historical.json for import" }));
    await screen.findByTestId("merge-preview");
    expect(screen.getByText("Selected: historical.json")).toBeInTheDocument();
    expect(data.importSnapshot).not.toHaveBeenCalled();
  });
});
