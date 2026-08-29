import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
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
    cleanup();
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

  it("customizes an app nickname and accent through the presentation editor", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => ({}) });
    vi.stubGlobal("fetch", fetchMock);

    const onChanged = vi.fn();
    render(<AppCenter apps={[assetsApp]} onChanged={onChanged} />);

    fireEvent.click(screen.getByRole("button", { name: /customize assets/i }));

    const editor = await screen.findByTestId("presentation-editor");
    expect(editor).toBeDefined();
    fireEvent.change(screen.getByLabelText("App nickname"), { target: { value: "My Inventory" } });
    fireEvent.change(screen.getByLabelText("Accent color"), { target: { value: "mint" } });
    fireEvent.click(screen.getByRole("button", { name: /^save$/i }));

    await waitFor(() => expect(onChanged).toHaveBeenCalledTimes(1));
    const call = fetchMock.mock.calls.find(([url]) => String(url).includes("apps.presentation"));
    expect(call).toBeDefined();
    const [path, init] = call!;
    expect(path).toBe("/api/core/settings/apps.presentation");
    expect(JSON.parse(String(init.body))).toEqual({
      value: { assets: { displayName: "My Inventory", accent: "mint" } },
    });
  });

  it("reflects existing overrides on the card", () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, json: async () => ({}) }));
    render(
      <AppCenter
        apps={[assetsApp]}
        presentation={{ assets: { displayName: "My Inventory", accent: "coral" } }}
        onChanged={() => undefined}
      />,
    );
    expect(screen.getByText("My Inventory")).toBeDefined();
    expect(screen.getByText(/customized/)).toBeDefined();
    const icon = document.querySelector('.app-card__icon[data-accent="coral"]');
    expect(icon).not.toBeNull();
  });
});
