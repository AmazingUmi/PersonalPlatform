import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AppInfo } from "../shared/api";
import { AppCenter } from "./AppCenter";

const assetsApp: AppInfo = {
  id: "assets",
  name: "Assets",
  version: "0.1.0",
  description: "",
  status: "enabled",
  enabled: true,
  defaultEnabled: true,
  route: "/assets",
  capabilities: { database: true, storage: true, scheduler: false, events: true },
  widgets: [{ id: "summary", name: "Asset Summary" }],
  hasBackend: true,
  hasFrontend: true,
};

describe("AppCenter", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("disables an enabled app and refreshes the list", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ ...assetsApp, status: "disabled", enabled: false }),
    });
    vi.stubGlobal("fetch", fetchMock);

    const onChanged = vi.fn();
    render(<AppCenter apps={[assetsApp]} onChanged={onChanged} />);

    fireEvent.click(screen.getByText("Disable"));

    await waitFor(() => expect(onChanged).toHaveBeenCalledTimes(1));
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/core/apps/assets/enabled",
      expect.objectContaining({ method: "PUT" }),
    );
  });

  it("shows activation errors independently with retry and disable actions", async () => {
    const failedApp: AppInfo = {
      ...assetsApp,
      status: "error",
      enabled: true,
      errorMessage: "registerEvents failed: boom",
    };
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ ...assetsApp, status: "enabled", enabled: true }),
    });
    vi.stubGlobal("fetch", fetchMock);

    const onChanged = vi.fn();
    render(<AppCenter apps={[failedApp]} onChanged={onChanged} />);

    // Error is displayed independently of the requested enable state.
    expect(screen.getByText(/activation failed/)).toBeDefined();
    expect(screen.getByText(/registerEvents failed: boom/)).toBeDefined();

    // Retry re-requests enable instead of leaving the app stuck.
    fireEvent.click(screen.getByText("Retry"));
    await waitFor(() => expect(onChanged).toHaveBeenCalledTimes(1));
    const [path, init] = fetchMock.mock.calls[0]!;
    expect(path).toBe("/api/core/apps/assets/enabled");
    expect(JSON.parse(String(init.body))).toEqual({ enabled: true });
  });
});
