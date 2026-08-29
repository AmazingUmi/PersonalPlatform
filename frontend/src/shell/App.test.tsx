import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "./App";
import { fetchApps, getSetting, type AppInfo } from "../shared/api";

vi.mock("../shared/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../shared/api")>();
  return {
    ...actual,
    fetchApps: vi.fn(),
    getSetting: vi.fn().mockResolvedValue(null),
    setAppEnabled: vi.fn(),
  };
});

import { fetchApps as fetchAppsMock, setAppEnabled as setAppEnabledMock } from "../shared/api";

const enabledApp: AppInfo = {
  id: "alpha",
  name: "Alpha",
  version: "0.1.0",
  description: "",
  status: "enabled",
  enabled: true,
  defaultEnabled: true,
  route: "/alpha",
  capabilities: { database: false, storage: false, scheduler: false, events: false },
  widgets: [],
  hasBackend: true,
  hasFrontend: true,
};

beforeEach(() => {
  vi.mocked(getSetting).mockResolvedValue(null);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

/**
 * FP-14.2: initial load, data, background refresh and refresh failure are
 * distinct states. A refresh failure after a successful load must keep the
 * old data, surface a non-blocking error banner and offer retry — never
 * silently pretend everything is fine.
 */
describe("App shell refresh states (FP-14.2)", () => {
  it("shows the boot screen while the initial load is pending", async () => {
    let release: ((items: AppInfo[]) => void) | undefined;
    const gate = new Promise<AppInfo[]>((resolve) => {
      release = resolve;
    });
    vi.mocked(fetchAppsMock).mockReturnValueOnce(gate as never);
    render(<App />);

    expect(await screen.findByText("Loading system…")).toBeTruthy();
    release?.([enabledApp]);
    await waitFor(() => expect(screen.queryByText("Loading system…")).toBeNull());
  });

  it("initial load failure shows the full error screen with retry", async () => {
    vi.mocked(fetchAppsMock).mockRejectedValueOnce(new Error("backend down"));
    render(<App />);

    expect(await screen.findByText(/Backend unavailable: backend down/)).toBeTruthy();
    expect(screen.getByRole("button", { name: /retry/i })).toBeTruthy();

    vi.mocked(fetchAppsMock).mockResolvedValueOnce([enabledApp] as never);
    fireEvent.click(screen.getByRole("button", { name: /retry/i }));
    await waitFor(() => expect(screen.queryByText(/Backend unavailable/)).toBeNull());
  });

  it("refresh failure keeps stale data, shows a banner, and retry recovers", async () => {
    vi.mocked(fetchAppsMock).mockResolvedValue([enabledApp] as never);
    render(<App />);
    await waitFor(() => expect(screen.getByText("Alpha")).toBeTruthy());

    // A background refresh (App Center mutation -> onChanged) fails while the
    // shell already holds data.
    vi.mocked(setAppEnabledMock).mockResolvedValueOnce({ ...enabledApp, status: "disabled" } as never);
    vi.mocked(fetchAppsMock).mockRejectedValueOnce(new Error("flaky refresh"));
    fireEvent.click(screen.getAllByRole("link", { name: /app center/i })[0]!);
    fireEvent.click(await screen.findByRole("button", { name: /^disable$/i }));

    // Stale data is still rendered next to the non-blocking banner.
    expect(await screen.findByText(/Refresh failed: flaky refresh/)).toBeTruthy();
    expect(screen.getByText(/showing previously loaded data/)).toBeTruthy();
    expect(screen.getAllByText("Alpha").length).toBeGreaterThan(0);
    expect(screen.queryByText(/Backend unavailable/)).toBeNull();

    // Retry succeeds: banner disappears, data stays.
    vi.mocked(fetchAppsMock).mockResolvedValueOnce([enabledApp] as never);
    fireEvent.click(screen.getAllByRole("button", { name: /retry/i })[0]!);
    await waitFor(() => expect(screen.queryByText(/Refresh failed/)).toBeNull());
    expect(screen.getAllByText("Alpha").length).toBeGreaterThan(0);
  });
});
