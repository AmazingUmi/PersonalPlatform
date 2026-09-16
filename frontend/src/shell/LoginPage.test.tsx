import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError, type AuthUser } from "../shared/api";
import { AuthProvider } from "./AuthContext";
import { LoginPage } from "./LoginPage";

vi.mock("../shared/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../shared/api")>();
  return {
    ...actual,
    fetchMe: vi.fn(),
    login: vi.fn(),
    logout: vi.fn(),
  };
});

import { fetchMe as fetchMeMock, login as loginMock } from "../shared/api";

/**
 * Login form behavior (AUTH-5): credentials reach POST login and a success
 * navigates to the preserved destination; a 401 renders the access-denied
 * StatusMessage and keeps the form usable.
 */

const adminUser: AuthUser = { id: "u-admin", username: "admin", displayName: "Admin", role: "admin" };

function LocationProbe() {
  const location = useLocation();
  return <p data-testid="location">{location.pathname}</p>;
}

function renderLogin(initialEntry = "/login") {
  return render(
    <MemoryRouter initialEntries={[initialEntry]}>
      <AuthProvider>
        <LocationProbe />
        <Routes>
          <Route path="/login" element={<LoginPage />} />
          <Route path="/" element={<p>dashboard</p>} />
        </Routes>
      </AuthProvider>
    </MemoryRouter>,
  );
}

beforeEach(() => {
  // Anonymous session so /login renders the form (not a redirect).
  vi.mocked(fetchMeMock).mockResolvedValue(null);
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("LoginPage", () => {
  it("submits the typed credentials and navigates on success", async () => {
    vi.mocked(loginMock).mockResolvedValue(adminUser);
    renderLogin();

    fireEvent.change(screen.getByLabelText("Username"), { target: { value: "admin" } });
    fireEvent.change(screen.getByLabelText("Password"), { target: { value: "top-secret-1" } });
    fireEvent.click(screen.getByRole("button", { name: "Log In ▸" }));

    await waitFor(() => expect(loginMock).toHaveBeenCalledTimes(1));
    expect(loginMock).toHaveBeenCalledWith("admin", "top-secret-1");
    // The successful signIn navigated to the default destination "/".
    await waitFor(() => expect(screen.getByTestId("location").textContent).toBe("/"));
    expect(screen.getByText("dashboard")).toBeTruthy();
    expect(screen.queryByText(/access denied/i)).toBeNull();
  });

  it("preserves the intercepted destination across a successful login", async () => {
    vi.mocked(loginMock).mockResolvedValue(adminUser);
    // Deep-link boot: the gate redirected /tasks → /login with state.from.
    render(
      <MemoryRouter initialEntries={[{ pathname: "/login", state: { from: "/tasks" } }]}>
        <AuthProvider>
          <LocationProbe />
          <Routes>
            <Route path="/login" element={<LoginPage />} />
            <Route path="/tasks" element={<p>tasks app</p>} />
          </Routes>
        </AuthProvider>
      </MemoryRouter>,
    );

    fireEvent.change(screen.getByLabelText("Username"), { target: { value: "admin" } });
    fireEvent.change(screen.getByLabelText("Password"), { target: { value: "top-secret-1" } });
    fireEvent.click(screen.getByRole("button", { name: "Log In ▸" }));

    await waitFor(() => expect(screen.getByTestId("location").textContent).toBe("/tasks"));
    expect(screen.getByText("tasks app")).toBeTruthy();
  });

  it("shows the access-denied message and stays on /login when login rejects 401", async () => {
    vi.mocked(loginMock).mockRejectedValueOnce(
      new ApiError("invalid username or password", 401, "invalid_credentials", null),
    );
    renderLogin();

    fireEvent.change(screen.getByLabelText("Username"), { target: { value: "admin" } });
    fireEvent.change(screen.getByLabelText("Password"), { target: { value: "wrong-password" } });
    fireEvent.click(screen.getByRole("button", { name: "Log In ▸" }));

    expect(await screen.findByText(/Access denied — unknown user or wrong password/i)).toBeTruthy();
    expect(loginMock).toHaveBeenCalledWith("admin", "wrong-password");
    // Still on the login page with the form ready for a retry.
    expect(screen.getByTestId("location").textContent).toBe("/login");
    expect(screen.getByRole("button", { name: "Log In ▸" })).toBeTruthy();
  });
});
