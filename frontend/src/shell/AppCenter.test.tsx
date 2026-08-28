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
});
