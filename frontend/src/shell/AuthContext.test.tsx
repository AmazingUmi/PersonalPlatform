import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError, UNAUTHORIZED_EVENT, type AuthUser } from "../shared/api";
import { AuthProvider, useAuth } from "./AuthContext";

vi.mock("../shared/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../shared/api")>();
  return {
    ...actual,
    fetchMe: vi.fn(),
    login: vi.fn(),
    logout: vi.fn(),
  };
});

import { fetchMe as fetchMeMock } from "../shared/api";

/**
 * Session bootstrap + loss (AUTH-5, AUTH-H1-07): /me resolves the boot status
 * — 200 authenticated, 401 anonymous, network/5xx the "error" availability
 * state (never "you are logged out"). A later 401 from any API
 * (UNAUTHORIZED_EVENT) flips an authenticated session back to anonymous so
 * the shell re-routes to /login.
 */

const adminUser: AuthUser = { id: "u-admin", username: "admin", displayName: "Admin", role: "admin" };

/** Consumer that prints the full provider state (drives it honestly). */
function AuthProbe() {
  const { status, user } = useAuth();
  return (
    <p data-testid="auth">
      {status}|{user?.username ?? "-"}|{user?.role ?? "-"}
    </p>
  );
}

/** Drives refresh() from tests (recovery / failure paths). */
function RefreshProbe() {
  const { refresh } = useAuth();
  return (
    <button type="button" onClick={() => void refresh()}>
      refresh
    </button>
  );
}

beforeEach(() => {
  vi.mocked(fetchMeMock).mockReset();
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("AuthProvider session states", () => {
  it("bootstraps to authenticated when /me resolves a user", async () => {
    vi.mocked(fetchMeMock).mockResolvedValue(adminUser);
    render(
      <AuthProvider>
        <AuthProbe />
      </AuthProvider>,
    );

    expect(await screen.findByText("authenticated|admin|admin")).toBeTruthy();
  });

  it("bootstraps to anonymous when /me resolves null (401)", async () => {
    vi.mocked(fetchMeMock).mockResolvedValue(null);
    render(
      <AuthProvider>
        <AuthProbe />
      </AuthProvider>,
    );

    expect(await screen.findByText("anonymous|-|-")).toBeTruthy();
  });

  it("treats a boot fetch failure (network/5xx) as the error state, NOT anonymous (AUTH-H1-07)", async () => {
    vi.mocked(fetchMeMock).mockRejectedValue(new Error("backend unreachable"));
    render(
      <AuthProvider>
        <AuthProbe />
      </AuthProvider>,
    );

    expect(await screen.findByText("error|-|-")).toBeTruthy();
  });

  it("a 5xx from /me lands in the error state too (availability, not identity)", async () => {
    vi.mocked(fetchMeMock).mockRejectedValue(
      new ApiError("HTTP 503", 503, "database_unavailable", undefined),
    );
    render(
      <AuthProvider>
        <AuthProbe />
      </AuthProvider>,
    );

    expect(await screen.findByText("error|-|-")).toBeTruthy();
  });

  it("flips an authenticated session to anonymous on UNAUTHORIZED_EVENT", async () => {
    vi.mocked(fetchMeMock).mockResolvedValue(adminUser);
    render(
      <AuthProvider>
        <AuthProbe />
      </AuthProvider>,
    );
    expect(await screen.findByText("authenticated|admin|admin")).toBeTruthy();

    // A later 401 from any API endpoint dispatches the session-loss event.
    act(() => {
      window.dispatchEvent(new CustomEvent(UNAUTHORIZED_EVENT));
    });

    expect(await screen.findByText("anonymous|-|-")).toBeTruthy();
  });

  it("refresh() recovers from the error state when the backend comes back", async () => {
    vi.mocked(fetchMeMock).mockRejectedValueOnce(new Error("backend unreachable"));
    render(
      <AuthProvider>
        <AuthProbe />
        <RefreshProbe />
      </AuthProvider>,
    );
    expect(await screen.findByText("error|-|-")).toBeTruthy();

    vi.mocked(fetchMeMock).mockResolvedValueOnce(adminUser);
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "refresh" }));
    });
    expect(await screen.findByText("authenticated|admin|admin")).toBeTruthy();
  });

  it("refresh() failure also lands in the error state (stays out of the login page)", async () => {
    vi.mocked(fetchMeMock).mockResolvedValue(adminUser);
    render(
      <AuthProvider>
        <AuthProbe />
        <RefreshProbe />
      </AuthProvider>,
    );
    expect(await screen.findByText("authenticated|admin|admin")).toBeTruthy();

    vi.mocked(fetchMeMock).mockRejectedValueOnce(new ApiError("HTTP 503", 503, "database_unavailable", undefined));
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "refresh" }));
    });
    expect(await screen.findByText("error|-|-")).toBeTruthy();
  });
});
