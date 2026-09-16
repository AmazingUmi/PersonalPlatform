import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { UNAUTHORIZED_EVENT, type AuthUser } from "../shared/api";
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
 * Session bootstrap + loss (AUTH-5): /me resolves the boot status; a later
 * 401 from any API (UNAUTHORIZED_EVENT) flips an authenticated session back
 * to anonymous so the shell re-routes to /login.
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

  it("treats a boot fetch error as anonymous (documented fallback)", async () => {
    vi.mocked(fetchMeMock).mockRejectedValue(new Error("backend unreachable"));
    render(
      <AuthProvider>
        <AuthProbe />
      </AuthProvider>,
    );

    expect(await screen.findByText("anonymous|-|-")).toBeTruthy();
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
});
