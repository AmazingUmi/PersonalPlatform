import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { I18nProvider, useI18n } from "../shared/i18n";
import { DataManagementPanel } from "./DataManagementPanel";
import { Settings } from "./Settings";
import { MemoryRouter, useLocation, useNavigate } from "react-router-dom";
import * as api from "../shared/api";
import * as data from "../shared/dataManagement";

let role = "admin";
vi.mock("../shared/api", async (original) => ({ ...await original<typeof import("../shared/api")>(), listUsers: vi.fn(), createUser: vi.fn() }));
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
function LocationControls() {
  const location = useLocation(); const navigate = useNavigate();
  return <><output data-testid="location">{location.search}</output><button onClick={() => navigate(-1)}>Browser back</button><button onClick={() => navigate(1)}>Browser forward</button></>;
}
function LanguageSwitch() {
  const { language, setLanguage } = useI18n();
  return <button onClick={() => setLanguage(language === "zh" ? "en" : "zh")}>Switch language</button>;
}
function renderChinese(section: "data" | "webdav", view = "connection") {
  return render(<I18nProvider initialLanguage="zh"><MemoryRouter initialEntries={[`/settings?section=${section}&view=${view}`]}>
    <DataManagementPanel section={section} /><LanguageSwitch />
  </MemoryRouter></I18nProvider>);
}
async function ready(section = "data", view = "connection", extra = "") {
  render(<MemoryRouter initialEntries={[`/settings?section=${section}&view=${view}${extra}`]}><Settings /><LocationControls /></MemoryRouter>);
  if (section === "webdav") await screen.findByDisplayValue(config.endpoint);
}
function goSection(name: string) { fireEvent.click(within(screen.getByRole("navigation", { name: "Settings sections" })).getByRole("link", { name: new RegExp(`^${name}`) })); }
function goView(name: string) { fireEvent.click(within(screen.getByRole("navigation", { name: "WebDAV sections" })).getByRole("link", { name })); }

describe("Settings data management", () => {
  beforeEach(() => {
    role = "admin";
    vi.mocked(data.getWebDav).mockResolvedValue({ ...config });
    vi.mocked(data.getBackupHistory).mockResolvedValue({ items: [] });
    vi.mocked(data.previewMerge).mockResolvedValue({ ...report });
    vi.mocked(data.importSnapshot).mockResolvedValue({ ...report });
    vi.mocked(api.listUsers).mockResolvedValue([]);
  });
  afterEach(() => { cleanup(); vi.resetAllMocks(); });

  it("offers all-user scope to administrators, and only own scope to ordinary users", async () => {
    role = "user";
    await ready();
    expect(within(screen.getByLabelText("Data scope")).getAllByRole("option")).toHaveLength(1);
    goSection("WebDAV"); await screen.findByDisplayValue(config.endpoint);
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

  it("tests a new unsaved connection without saving it and clears stale success on edits", async () => {
    vi.mocked(data.getWebDav).mockResolvedValue({ ...config, configured: false, endpoint: "", username: "", hasPassword: false, intervalHours: 0 });
    vi.mocked(data.testWebDav).mockResolvedValue({ ok: true });
    await ready(); goSection("WebDAV");
    const test = await screen.findByRole("button", { name: "Test connection" });
    expect(test).toBeDisabled();
    fireEvent.change(screen.getByLabelText("WebDAV folder URL"), { target: { value: "https://dav.jianguoyun.com/dav/" } });
    fireEvent.change(screen.getByLabelText("WebDAV username"), { target: { value: "person@example.com" } });
    expect(test).toBeDisabled();
    fireEvent.change(screen.getByLabelText("WebDAV password or app token"), { target: { value: "app-password" } });
    expect(test).toBeEnabled();
    fireEvent.click(test);
    await screen.findByText(/Connection successful. WebDAV directory is reachable/);
    expect(data.testWebDav).toHaveBeenCalledWith({ endpoint: "https://dav.jianguoyun.com/dav/", username: "person@example.com", password: "app-password" });
    expect(data.saveWebDav).not.toHaveBeenCalled();
    expect(screen.getByLabelText("WebDAV password or app token")).toHaveValue("app-password");
    fireEvent.change(screen.getByLabelText("WebDAV username"), { target: { value: "someone-else@example.com" } });
    expect(screen.queryByText(/Connection successful/)).not.toBeInTheDocument();
    goView("Backup");
    expect(screen.queryByRole("button", { name: "Back up now" })).not.toBeInTheDocument();
  });

  it("tests edited settings with the saved password only for the same normalized destination and username", async () => {
    vi.mocked(data.testWebDav).mockResolvedValue({ ok: true });
    await ready("webdav");
    fireEvent.change(screen.getByLabelText("WebDAV folder URL"), { target: { value: config.endpoint.slice(0, -1) } });
    fireEvent.change(screen.getByLabelText("Automatic backup"), { target: { value: "6" } });
    const test = screen.getByRole("button", { name: "Test connection" });
    expect(test).toBeEnabled(); fireEvent.click(test);
    await screen.findByText(/Connection successful/);
    expect(data.testWebDav).toHaveBeenCalledWith({ endpoint: config.endpoint.slice(0, -1), username: config.username });
    fireEvent.change(screen.getByLabelText("WebDAV username"), { target: { value: "new-user" } });
    expect(test).toBeDisabled();
    fireEvent.change(screen.getByLabelText("WebDAV username"), { target: { value: config.username } });
    fireEvent.change(screen.getByLabelText("WebDAV folder URL"), { target: { value: "https://another.example/" } });
    expect(test).toBeDisabled();
    expect(data.saveWebDav).not.toHaveBeenCalled();
  });

  it("disables repeat connection tests and preserves the draft after a network error", async () => {
    let reject!: (error: Error) => void;
    vi.mocked(data.testWebDav).mockImplementation(() => new Promise((_, fail) => { reject = fail; }));
    await ready("webdav");
    fireEvent.change(screen.getByLabelText("WebDAV password or app token"), { target: { value: "replacement-token" } });
    const test = screen.getByRole("button", { name: "Test connection" });
    fireEvent.click(test);
    expect(test).toBeDisabled();
    expect(screen.getByRole("button", { name: "Save backup settings" })).toBeDisabled();
    reject(new Error("DNS returned a reserved address; check Fake-IP settings."));
    await screen.findByText(/DNS returned a reserved address/);
    expect(screen.getByLabelText("WebDAV password or app token")).toHaveValue("replacement-token");
    expect(test).toBeEnabled();
    expect(data.testWebDav).toHaveBeenCalledTimes(1);
    expect(data.saveWebDav).not.toHaveBeenCalled();
  });

  it("preserves a saved password when changing the automatic interval and blocks unsaved actions", async () => {
    vi.mocked(data.saveWebDav).mockResolvedValue({ ...config, intervalHours: 6 });
    await ready("webdav", "connection");
    expect(screen.getByLabelText("WebDAV password or app token")).toHaveValue("");
    fireEvent.change(screen.getByLabelText("Automatic backup"), { target: { value: "6" } });
    goView("Backup");
    expect(screen.getByRole("button", { name: "Back up now" })).toBeDisabled();
    goView("Connection");
    fireEvent.click(screen.getByRole("button", { name: "Save backup settings" }));
    await screen.findByText("Backup settings saved.");
    expect(data.saveWebDav).toHaveBeenCalledWith({ endpoint: config.endpoint, username: config.username, scope: "own", intervalHours: 6 });
    goView("Backup");
    expect(screen.getByRole("button", { name: "Back up now" })).toBeEnabled();
    expect(screen.getByLabelText("WebDAV password or app token")).toHaveValue("");
  });

  it("requires new credentials when changing the destination and clears them after saving", async () => {
    vi.mocked(data.saveWebDav).mockResolvedValue({ ...config, endpoint: "https://other.example/" });
    await ready("webdav", "connection");
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
    await ready("webdav", "backup");
    fireEvent.click(screen.getByRole("button", { name: "Back up now" }));
    await screen.findByText("WebDAV authentication failed.");
    expect(screen.queryByText(/Backup saved:/)).not.toBeInTheDocument();
  });

  it("defaults manual WebDAV to incremental and shows the actual uploaded amount", async () => {
    vi.mocked(data.backupWebDav).mockResolvedValue({ status: "created", backup, uploadedBytes: 256, uploadedObjects: 2 });
    await ready("webdav", "backup");
    expect(screen.getByLabelText("Manual backup mode")).toHaveValue("incremental");
    fireEvent.click(screen.getByRole("button", { name: "Back up now" }));
    await screen.findByText(/Backup saved: historical.json. Uploaded 0.3 KiB in 2 object/);
    expect(data.backupWebDav).toHaveBeenCalledWith("incremental");
  });

  it("lets a user choose a full WebDAV backup without changing the automatic schedule", async () => {
    vi.mocked(data.backupWebDav).mockResolvedValue({ status: "created", backup: { ...backup, kind: "full" }, uploadedBytes: 4096, uploadedObjects: 1 });
    await ready("webdav", "backup");
    fireEvent.change(screen.getByLabelText("Manual backup mode"), { target: { value: "full" } });
    fireEvent.click(screen.getByRole("button", { name: "Back up now" }));
    await screen.findByText(/Uploaded 4.0 KiB in 1 object/);
    expect(data.backupWebDav).toHaveBeenCalledWith("full");
    expect(data.saveWebDav).not.toHaveBeenCalled();
    expect(screen.getByLabelText("Automatic backup")).toHaveValue("24");
  });

  it("reports no changes without inventing another backup entry", async () => {
    vi.mocked(data.backupWebDav).mockResolvedValue({ status: "unchanged", backup: null, uploadedBytes: 0, uploadedObjects: 0 });
    await ready("webdav", "backup");
    fireEvent.click(screen.getByRole("button", { name: "Back up now" }));
    await screen.findByText("Data is unchanged. Nothing was uploaded and no new backup was created.");
    goView("History");
    expect(screen.getByText("No backups recorded yet.")).toBeVisible();
    expect(screen.queryByText(/Backup saved:/)).not.toBeInTheDocument();
  });

  it("distinguishes repaired remote objects from a zero-upload unchanged result", async () => {
    vi.mocked(data.backupWebDav).mockResolvedValue({ status: "unchanged", backup: null, uploadedBytes: 2048, uploadedObjects: 1 });
    await ready("webdav", "backup");
    fireEvent.click(screen.getByRole("button", { name: "Back up now" }));
    await screen.findByText("Data is unchanged. Repaired 1 missing object(s), uploading 2.0 KiB. No new backup was created.");
    expect(screen.queryByText(/Nothing was uploaded/)).not.toBeInTheDocument();
  });

  it("requires confirmation to remove a connection and disables subsequent backups", async () => {
    vi.mocked(data.deleteWebDav).mockResolvedValue(undefined);
    await ready("webdav", "connection");
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
    await ready("webdav", "history");
    expect(screen.getByText(/Incremental · My data.*Full data 4.0 KiB · Uploaded 0.3 KiB/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Review historical.json for import" }));
    await screen.findByTestId("merge-preview");
    expect(screen.getByText("Selected: historical.json")).toBeInTheDocument();
    expect(data.importSnapshot).not.toHaveBeenCalled();
  });

  it("loads only visited sections, retains drafts, and follows browser history", async () => {
    await ready("general", "connection", "&keep=yes");
    expect(data.getWebDav).not.toHaveBeenCalled();
    expect(api.listUsers).not.toHaveBeenCalled();
    expect(screen.getByRole("heading", { name: "System" })).toBeVisible();
    goSection("Data"); chooseFile();
    await screen.findByText("Selected: previous-backup.json");
    fireEvent.click(screen.getByRole("button", { name: "Preview merge" }));
    await screen.findByTestId("merge-preview");
    goSection("WebDAV"); await screen.findByDisplayValue(config.endpoint);
    fireEvent.change(screen.getByLabelText("WebDAV username"), { target: { value: "draft-name" } });
    goView("Backup");
    expect(screen.queryByRole("button", { name: "Save backup settings" })).not.toBeInTheDocument();
    goSection("Data");
    expect(screen.getByTestId("merge-preview")).toBeVisible();
    expect(screen.queryByRole("heading", { name: "System" })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Browser back" }));
    expect(screen.getByRole("button", { name: "Back up now" })).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Browser forward" }));
    expect(screen.getByTestId("merge-preview")).toBeVisible();
    goSection("WebDAV"); goView("Connection");
    expect(screen.getByLabelText("WebDAV username")).toHaveValue("draft-name");
    expect(data.getWebDav).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId("location")).toHaveTextContent("keep=yes");
    goSection("Users"); await waitFor(() => expect(api.listUsers).toHaveBeenCalledTimes(1));
  });

  it.each(["users", "invalid"])("falls back safely for an ordinary user's %s link", async (section) => {
    role = "user";
    await ready(section);
    expect(screen.getByRole("heading", { name: "System" })).toBeVisible();
    expect(screen.queryByRole("link", { name: "Users" })).not.toBeInTheDocument();
    expect(api.listUsers).not.toHaveBeenCalled();
    expect(data.getWebDav).not.toHaveBeenCalled();
  });

  it("uses a real styled picker, preserves selection on cancel and allows clear/reselection", async () => {
    await ready();
    const input = screen.getByLabelText("Backup file");
    const click = vi.spyOn(input, "click");
    const button = screen.getByRole("button", { name: "Choose file" });
    expect(button).toHaveClass("px-button", "px-button--md");
    expect(input).not.toBeVisible();
    fireEvent.click(button); expect(click).toHaveBeenCalledTimes(1);
    chooseFile(); await screen.findByText("Selected: previous-backup.json");
    fireEvent.change(input, { target: { files: [] } });
    expect(screen.getByText("Selected: previous-backup.json")).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Clear selection" }));
    expect(screen.getByText("No file selected")).toBeVisible();
    chooseFile(); await screen.findByText("Selected: previous-backup.json");
  });

  it("keeps the previous import draft visible after a failed remote review", async () => {
    vi.mocked(data.getBackupHistory).mockResolvedValue({ items: [backup] });
    vi.mocked(data.downloadBackup).mockRejectedValue(new Error("Remote file is missing."));
    await ready(); chooseFile(); await screen.findByText("Selected: previous-backup.json");
    fireEvent.click(screen.getByRole("button", { name: "Preview merge" }));
    await screen.findByTestId("merge-preview");
    goSection("WebDAV"); await screen.findByDisplayValue(config.endpoint); goView("History");
    fireEvent.click(screen.getByRole("button", { name: "Review historical.json for import" }));
    await screen.findByText("Remote file is missing.");
    expect(screen.getByText("Remote file is missing.")).toBeVisible();
    expect(screen.getByText("Selected: previous-backup.json")).toBeVisible();
    expect(screen.getByTestId("merge-preview")).toBeVisible();
    expect(screen.getByRole("heading", { name: "Data management" })).toHaveFocus();
  });

  it.each([0, 1, 10, 11, 100])("paginates %i loaded records with short action labels", async (count) => {
    vi.mocked(data.getBackupHistory).mockResolvedValue({ items: Array.from({ length: count }, (_, i) => ({ ...backup, id: String(i), filename: `backup-${i}.json` })) });
    await ready("webdav", "history");
    expect(screen.queryAllByRole("button", { name: /^Download / })).toHaveLength(Math.min(count, 10));
    if (count === 0) { expect(screen.queryByRole("navigation", { name: "Backup history pages" })).not.toBeInTheDocument(); return; }
    expect(screen.getByRole("button", { name: "Previous page" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Download backup-0.json" })).toHaveTextContent(/^Download$/);
    if (count > 10) {
      fireEvent.click(screen.getByRole("button", { name: "Next page" }));
      expect(screen.getByRole("button", { name: "Download backup-10.json" })).toBeVisible();
      expect(screen.queryByRole("button", { name: "Download backup-0.json" })).not.toBeInTheDocument();
      vi.mocked(data.getBackupHistory).mockResolvedValue({ items: [backup] });
      fireEvent.click(screen.getByRole("button", { name: "Refresh history" }));
      await screen.findByRole("button", { name: "Download historical.json" });
      expect(screen.getByText("Page 1 of 1 · 1 records")).toBeVisible();
      expect(screen.getByRole("button", { name: "Next page" })).toBeDisabled();
    } else expect(screen.getByRole("button", { name: "Next page" })).toBeDisabled();
  });

  it.each(["-1", "abc", "2.5", "999"])("normalizes invalid or out-of-range history page %s", async (page) => {
    vi.mocked(data.getBackupHistory).mockResolvedValue({ items: [backup] });
    await ready("webdav", "history", `&page=${page}&keep=yes`);
    expect(screen.getByText("Page 1 of 1 · 1 records")).toBeVisible();
    await waitFor(() => expect(screen.getByTestId("location")).toHaveTextContent("page=1"));
    expect(screen.getByTestId("location")).toHaveTextContent("keep=yes");
  });


  it("keeps the local draft until remote preview succeeds and disables repeat work", async () => {
    vi.mocked(data.getBackupHistory).mockResolvedValue({ items: [backup] });
    const blob = new Blob(["{}"]);
    Object.defineProperty(blob, "text", { value: async () => "{}" });
    vi.mocked(data.downloadBackup).mockResolvedValue({ blob, filename: backup.filename });
    await ready(); chooseFile(); await screen.findByText("Selected: previous-backup.json");
    fireEvent.click(screen.getByRole("button", { name: "Preview merge" }));
    await screen.findByTestId("merge-preview");
    let rejectPreview!: (error: Error) => void;
    vi.mocked(data.previewMerge).mockImplementationOnce(() => new Promise((_, reject) => { rejectPreview = reject; }));
    goSection("WebDAV"); await screen.findByDisplayValue(config.endpoint); goView("History");
    fireEvent.click(screen.getByRole("button", { name: "Review historical.json for import" }));
    await waitFor(() => expect(data.previewMerge).toHaveBeenCalledTimes(2));
    expect(screen.getByRole("button", { name: "Choose file" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Merge missing data" })).toBeDisabled();
    expect(screen.getByText("Selected: previous-backup.json")).toBeVisible();
    rejectPreview(new Error("Remote preview has conflicts."));
    await screen.findByText("Remote preview has conflicts.");
    expect(screen.getByText("Selected: previous-backup.json")).toBeVisible();
    expect(screen.getByTestId("merge-preview")).toBeVisible();
    expect(screen.getByRole("button", { name: "Choose file" })).toBeEnabled();
  });

  it("falls back to Connection for an unknown WebDAV view", async () => {
    await ready("webdav", "unknown");
    expect(screen.getByRole("link", { name: "Connection" })).toHaveAttribute("aria-current", "page");
    expect(screen.getByLabelText("WebDAV folder URL")).toBeVisible();
    expect(screen.queryByRole("button", { name: "Back up now" })).not.toBeInTheDocument();
  });

  it.each(["admin", "user"])("keeps %s data scope permissions and a selected file across language switches", async (userRole) => {
    role = userRole;
    renderChinese("data");
    const scope = screen.getByLabelText("数据范围");
    expect(within(scope).getAllByRole("option")).toHaveLength(userRole === "admin" ? 2 : 1);
    if (userRole === "admin") {
      fireEvent.change(scope, { target: { value: "all" } });
      expect(screen.getByText(/此备份包含所有用户的应用数据和账号密码散列/)).toBeVisible();
      fireEvent.change(scope, { target: { value: "own" } });
    }
    expect(screen.queryByText(/备份为 JSON 格式/)).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "帮助：关于数据备份" }));
    expect(screen.getByRole("dialog", { name: "关于数据备份" })).toHaveTextContent("32 MiB");
    fireEvent.click(screen.getByRole("button", { name: "关闭帮助" }));
    expect(screen.getByRole("button", { name: "选择文件" })).toHaveClass("px-button");
    const file = new File(["{}"], "保留 Original.json", { type: "application/json" });
    Object.defineProperty(file, "text", { value: async () => "{}" });
    fireEvent.change(screen.getByLabelText("备份文件"), { target: { files: [file] } });
    await screen.findByText("已选择：保留 Original.json");
    fireEvent.click(screen.getByRole("button", { name: "预览合并" }));
    const preview = await screen.findByTestId("merge-preview");
    expect(within(preview).getByRole("cell", { name: "任务" })).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Switch language" }));
    expect(screen.getByText("Selected: 保留 Original.json")).toBeVisible();
    expect(screen.getByTestId("merge-preview")).toBeVisible();
    expect(screen.getByLabelText("Data scope")).toHaveValue("own");
    expect(within(preview).getByRole("cell", { name: "Tasks" })).toBeVisible();
    expect(data.importSnapshot).not.toHaveBeenCalled();
  });

  it("localizes WebDAV help and connection results without clearing credential drafts", async () => {
    vi.mocked(data.testWebDav).mockResolvedValue({ ok: true });
    renderChinese("webdav");
    await screen.findByDisplayValue(config.endpoint);
    expect(screen.getByRole("option", { name: "每 24 小时" })).toHaveValue("24");
    expect(screen.queryByRole("link", { name: "坚果云官方说明" })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "帮助：连接设置" }));
    expect(screen.getByRole("link", { name: "坚果云官方说明" })).toHaveAttribute("href", "https://help.jianguoyun.com/?p=3234");
    fireEvent.click(screen.getByRole("button", { name: "关闭帮助" }));
    fireEvent.change(screen.getByLabelText("WebDAV 用户名"), { target: { value: "draft@example.com" } });
    fireEvent.change(screen.getByLabelText("WebDAV 密码或应用授权密码"), { target: { value: "draft-password" } });
    fireEvent.change(screen.getByLabelText("自动备份"), { target: { value: "6" } });
    fireEvent.click(screen.getByRole("button", { name: "测试连接" }));
    await screen.findByText(/连接成功，WebDAV 目录可访问/);
    fireEvent.click(screen.getByRole("button", { name: "Switch language" }));
    expect(screen.getByText(/Connection successful. WebDAV directory is reachable/)).toBeVisible();
    expect(screen.getByLabelText("WebDAV username")).toHaveValue("draft@example.com");
    expect(screen.getByLabelText("WebDAV password or app token")).toHaveValue("draft-password");
    expect(screen.getByLabelText("Automatic backup")).toHaveValue("6");
    expect(data.saveWebDav).not.toHaveBeenCalled();
    expect(data.testWebDav).toHaveBeenCalledWith({ endpoint: config.endpoint, username: "draft@example.com", password: "draft-password" });
  });

  it("localizes full backup results and history while keeping filenames and API mode unchanged", async () => {
    vi.mocked(data.backupWebDav).mockResolvedValue({ status: "created", backup, uploadedBytes: 256, uploadedObjects: 2 });
    vi.mocked(data.getBackupHistory).mockResolvedValue({ items: [backup] });
    renderChinese("webdav", "backup");
    await screen.findByRole("button", { name: "立即备份" });
    expect(screen.getByText(new Date(config.nextRunAt!).toLocaleString("zh-CN"))).toBeVisible();
    fireEvent.change(screen.getByLabelText("手动备份方式"), { target: { value: "full" } });
    fireEvent.click(screen.getByRole("button", { name: "立即备份" }));
    await screen.findByText("备份已保存：historical.json。已上传 0.3 KiB，共 2 个对象。");
    expect(data.backupWebDav).toHaveBeenCalledWith("full");
    fireEvent.click(screen.getByRole("link", { name: "历史" }));
    expect(screen.getByRole("button", { name: "预览 historical.json 以导入" })).toBeVisible();
    expect(screen.getByText(/增量 · 我的数据/)).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Switch language" }));
    expect(screen.getByText("Backup saved: historical.json. Uploaded 0.3 KiB in 2 object(s).")).toBeVisible();
    expect(screen.getByRole("button", { name: "Download historical.json" })).toBeVisible();
    expect(screen.getByLabelText("Manual backup mode")).toHaveValue("full");
  });

  it("updates known backup validation errors on language switch", async () => {
    renderChinese("data");
    const text = vi.fn();
    fireEvent.change(screen.getByLabelText("备份文件"), { target: { files: [{ name: "huge.json", size: data.MAX_SNAPSHOT_BYTES + 1, text }] } });
    await screen.findByText("备份超过了 32 MiB 的大小限制。");
    fireEvent.click(screen.getByRole("button", { name: "Switch language" }));
    expect(screen.getByText("The backup exceeds the 32 MiB limit.")).toBeVisible();
    expect(text).not.toHaveBeenCalled();
  });

});
