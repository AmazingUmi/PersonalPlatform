import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import TasksApp from "./index";

function jsonResponse(body: unknown, ok = true, status = 200): Response {
  return { ok, status, json: async () => body } as unknown as Response;
}

const sampleTask = {
  id: "task-1",
  title: "Ship release",
  description: null,
  status: "todo",
  start_at: "2026-08-28T09:00:00.000Z",
  due_at: "2026-08-30T18:00:00.000Z",
  priority: 3,
  completed_at: null,
  created_at: "2026-08-01T00:00:00.000Z",
  updated_at: "2026-08-01T00:00:00.000Z",
};

function setupFetch(items: unknown[] = [sampleTask]) {
  const fetchMock = vi.fn(async (input: URL | RequestInfo, init?: RequestInit) => {
    const url = String(input);
    if (url.startsWith("/api/apps/tasks/tasks")) {
      if (init?.method === "POST" || init?.method === "PATCH" || init?.method === "DELETE") {
        return jsonResponse(sampleTask);
      }
      return jsonResponse({ items });
    }
    if (url.includes("/summary")) return jsonResponse({ today: 1, overdue: 0, done: 0 });
    return jsonResponse(null, false, 404);
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

function renderPage(initialEntry = "/tasks") {
  const page = TasksApp.routes[0]!.element;
  return render(<MemoryRouter initialEntries={[initialEntry]}>{page}</MemoryRouter>);
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("TasksPage", () => {
  it("renders task rows with priority, deadline and controls", async () => {
    setupFetch();
    renderPage();

    expect(await screen.findByText("Ship release")).toBeDefined();
    expect(screen.getByText("Urgent", { selector: ".px-badge" })).toBeDefined();
    expect(screen.getByRole("button", { name: /edit task "ship release"/i })).toBeDefined();
    expect(screen.getByRole("button", { name: /delete task "ship release"/i })).toBeDefined();
  });

  it("creates a task through the editor with start, deadline and priority", async () => {
    const fetchMock = setupFetch();
    renderPage();

    fireEvent.click(screen.getByRole("button", { name: /new task/i }));
    expect(await screen.findByTestId("task-editor")).toBeDefined();

    fireEvent.change(screen.getByLabelText("Task title"), { target: { value: "Write docs" } });
    fireEvent.change(screen.getByLabelText("Priority"), { target: { value: "2" } });
    fireEvent.change(screen.getByLabelText("Start time"), { target: { value: "2026-08-29T09:00" } });
    fireEvent.change(screen.getByLabelText("Deadline"), { target: { value: "2026-08-31T17:00" } });
    fireEvent.click(screen.getByRole("button", { name: /create task/i }));

    await waitFor(() => {
      const call = fetchMock.mock.calls.find(([, init]) => (init as RequestInit | undefined)?.method === "POST");
      expect(call).toBeDefined();
      const body = JSON.parse(String((call![1] as RequestInit).body));
      expect(body.title).toBe("Write docs");
      expect(body.priority).toBe(2);
      expect(body.startAt).toBe(new Date("2026-08-29T09:00").toISOString());
      expect(body.dueAt).toBe(new Date("2026-08-31T17:00").toISOString());
    });
  });

  it("loads the list with filters from the URL", async () => {
    const fetchMock = setupFetch();
    renderPage("/tasks?status=todo&priority=3&sortBy=dueAt&order=asc");

    await waitFor(() => {
      const call = fetchMock.mock.calls.find(([url]) => String(url).includes("/api/apps/tasks/tasks?"));
      const url = String(call![0]);
      expect(url).toContain("status=todo");
      expect(url).toContain("priority=3");
      expect(url).toContain("sortBy=dueAt");
      expect(url).toContain("order=asc");
    });
  });

  it("asks for confirmation before deleting a task", async () => {
    setupFetch();
    renderPage();

    await screen.findByText("Ship release");
    fireEvent.click(screen.getByRole("button", { name: /delete task "ship release"/i }));
    expect(await screen.findByTestId("confirm-dialog")).toBeDefined();
    expect(screen.getByText(/delete "ship release"/i)).toBeDefined();
  });

  it("marks overdue tasks through the danger badge", async () => {
    setupFetch([
      {
        ...sampleTask,
        title: "Late thing",
        due_at: "2020-01-01T00:00:00.000Z",
      },
    ]);
    renderPage();
    await screen.findByText("Late thing");
    expect(screen.getByText(/Due /, { selector: ".px-badge" }).className).toContain("px-badge--danger");
  });
});
