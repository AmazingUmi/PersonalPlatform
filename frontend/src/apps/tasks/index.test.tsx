import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import TasksApp from "./index";
import { I18nProvider, useI18n } from "../../shared/i18n";
import { AuthProvider } from "../../shell/AuthContext";
import { SYNC_DATA_CHANGED } from "../../shared/sync";

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

const HASH_A = "a".repeat(64);
const HASH_B = "b".repeat(64);
const AUTH_USER = { id: "user-1", username: "ada", displayName: null, role: "user" as const };

function emitOwnSync() {
  act(() => {
    window.dispatchEvent(new CustomEvent(SYNC_DATA_CHANGED, {
      detail: { userId: "user-1", identityId: "replica-1", result: "committed", baseline: false, openConflicts: 0 },
    }));
  });
}

function renderSignedInTasks() {
  const page = TasksApp.routes[0]!.element;
  return render(
    <I18nProvider initialLanguage="en">
      <AuthProvider>
        <MemoryRouter initialEntries={["/tasks"]}>{page}</MemoryRouter>
      </AuthProvider>
    </I18nProvider>,
  );
}

describe("TasksPage sync draft", () => {
  it("applies a clean background fetch as fields and hash together", async () => {
    let items = [{ ...sampleTask, title: "Ship release", baseHash: HASH_A }];
    const fetchMock = vi.fn(async (input: URL | RequestInfo, init?: RequestInit) => {
      const url = String(input);
      if (url === "/api/core/auth/me") return jsonResponse(AUTH_USER);
      if (url.includes("/summary")) return jsonResponse({ today: 1, overdue: 0, done: 0 });
      if (url.startsWith("/api/apps/tasks/tasks")) {
        if (init?.method === "PATCH") return jsonResponse(items[0]);
        return jsonResponse({ items });
      }
      return jsonResponse(null, false, 404);
    });
    vi.stubGlobal("fetch", fetchMock);
    renderSignedInTasks();
    fireEvent.click(await screen.findByRole("button", { name: /edit task "ship release"/i }));
    expect(await screen.findByTestId("task-editor")).toBeDefined();
    await waitFor(() => expect(fetchMock.mock.calls.some(([url]) => String(url) === "/api/core/auth/me")).toBe(true));
    items = [{ ...sampleTask, title: "Server title", baseHash: HASH_B }];
    emitOwnSync();
    await waitFor(() => expect(screen.getByLabelText("Task title")).toHaveValue("Server title"));
    fireEvent.change(screen.getByLabelText("Task title"), { target: { value: "Server title!" } });
    fireEvent.click(screen.getByRole("button", { name: /save changes/i }));
    await waitFor(() => {
      const call = fetchMock.mock.calls.find(([, init]) => (init as RequestInit | undefined)?.method === "PATCH");
      expect(call).toBeDefined();
      expect(JSON.parse(String((call![1] as RequestInit).body))).toMatchObject({ title: "Server title!", baseHash: HASH_B });
    });
  });

  it("keeps a draft and the old hash when the user types during a fetch", async () => {
    let items = [{ ...sampleTask, title: "Ship release", baseHash: HASH_A }];
    let hold: ((value: Response) => void) | null = null;
    const fetchMock = vi.fn(async (input: URL | RequestInfo, init?: RequestInit) => {
      const url = String(input);
      if (url === "/api/core/auth/me") return jsonResponse(AUTH_USER);
      if (url.includes("/summary")) return jsonResponse({ today: 1, overdue: 0, done: 0 });
      if (url.startsWith("/api/apps/tasks/tasks") && (!init?.method || init.method === "GET")) {
        if (hold) return new Promise<Response>((resolve) => { hold = resolve; });
        return jsonResponse({ items });
      }
      if (url.startsWith("/api/apps/tasks/tasks") && init?.method === "PATCH") return jsonResponse(items[0]);
      return jsonResponse(null, false, 404);
    });
    vi.stubGlobal("fetch", fetchMock);
    renderSignedInTasks();
    fireEvent.click(await screen.findByRole("button", { name: /edit task "ship release"/i }));
    await screen.findByTestId("task-editor");
    await waitFor(() => expect(fetchMock.mock.calls.some(([url]) => String(url) === "/api/core/auth/me")).toBe(true));
    hold = () => undefined;
    items = [{ ...sampleTask, title: "Server title", baseHash: HASH_B }];
    emitOwnSync();
    await waitFor(() => expect(hold).not.toBeNull());
    fireEvent.change(screen.getByLabelText("Task title"), { target: { value: "Kept draft" } });
    act(() => { hold?.(jsonResponse({ items }) as Response); });
    await waitFor(() => expect(screen.getByLabelText("Task title")).toHaveValue("Kept draft"));
    fireEvent.click(screen.getByRole("button", { name: /save changes/i }));
    await waitFor(() => {
      const call = fetchMock.mock.calls.find(([, init]) => (init as RequestInit | undefined)?.method === "PATCH");
      expect(JSON.parse(String((call![1] as RequestInit).body))).toMatchObject({ title: "Kept draft", baseHash: HASH_A });
    });
  });

  it("keeps the draft after a failed discard reload and does not auto-adopt later", async () => {
    let items = [{ ...sampleTask, title: "Ship release", baseHash: HASH_A }];
    let failGet = false;
    const fetchMock = vi.fn(async (input: URL | RequestInfo, init?: RequestInit) => {
      const url = String(input);
      if (url === "/api/core/auth/me") return jsonResponse(AUTH_USER);
      if (url.includes("/summary")) return jsonResponse({ today: 1, overdue: 0, done: 0 });
      if (url.startsWith("/api/apps/tasks/tasks") && (!init?.method || init.method === "GET")) {
        if (failGet) return jsonResponse({ error: { message: "offline" } }, false, 500);
        return jsonResponse({ items });
      }
      return jsonResponse(null, false, 404);
    });
    vi.stubGlobal("fetch", fetchMock);
    renderSignedInTasks();
    fireEvent.click(await screen.findByRole("button", { name: /edit task "ship release"/i }));
    await screen.findByTestId("task-editor");
    await waitFor(() => expect(fetchMock.mock.calls.some(([url]) => String(url) === "/api/core/auth/me")).toBe(true));
    fireEvent.change(screen.getByLabelText("Task title"), { target: { value: "Local draft" } });
    emitOwnSync();
    expect(await screen.findByRole("button", { name: "Discard draft and reload" })).toBeTruthy();
    failGet = true;
    fireEvent.click(screen.getByRole("button", { name: "Discard draft and reload" }));
    await waitFor(() => expect(screen.getByLabelText("Task title")).toHaveValue("Local draft"));
    failGet = false;
    items = [{ ...sampleTask, title: "Remote title", baseHash: HASH_B }];
    const gets = fetchMock.mock.calls.filter(([url, init]) =>
      String(url).startsWith("/api/apps/tasks/tasks") && (!init?.method || (init as RequestInit).method === "GET"),
    ).length;
    emitOwnSync();
    expect(fetchMock.mock.calls.filter(([url, init]) =>
      String(url).startsWith("/api/apps/tasks/tasks") && (!init?.method || (init as RequestInit).method === "GET"),
    ).length).toBe(gets);
    expect(screen.getByLabelText("Task title")).toHaveValue("Local draft");
  });

  it("adopts fields and hash on a successful discard reload", async () => {
    let items = [{ ...sampleTask, title: "Ship release", baseHash: HASH_A }];
    const fetchMock = vi.fn(async (input: URL | RequestInfo, init?: RequestInit) => {
      const url = String(input);
      if (url === "/api/core/auth/me") return jsonResponse(AUTH_USER);
      if (url.includes("/summary")) return jsonResponse({ today: 1, overdue: 0, done: 0 });
      if (url.startsWith("/api/apps/tasks/tasks") && init?.method === "PATCH") return jsonResponse(items[0]);
      if (url.startsWith("/api/apps/tasks/tasks")) return jsonResponse({ items });
      return jsonResponse(null, false, 404);
    });
    vi.stubGlobal("fetch", fetchMock);
    renderSignedInTasks();
    fireEvent.click(await screen.findByRole("button", { name: /edit task "ship release"/i }));
    await screen.findByTestId("task-editor");
    await waitFor(() => expect(fetchMock.mock.calls.some(([url]) => String(url) === "/api/core/auth/me")).toBe(true));
    fireEvent.change(screen.getByLabelText("Task title"), { target: { value: "Local draft" } });
    emitOwnSync();
    items = [{ ...sampleTask, title: "Remote title", baseHash: HASH_B }];
    fireEvent.click(await screen.findByRole("button", { name: "Discard draft and reload" }));
    await waitFor(() => expect(screen.getByLabelText("Task title")).toHaveValue("Remote title"));
    expect(screen.queryByRole("button", { name: "Discard draft and reload" })).toBeNull();
    expect(screen.queryByText("Server data changed. Your unsaved edits are kept.")).toBeNull();
    fireEvent.change(screen.getByLabelText("Task title"), { target: { value: "Remote title!" } });
    fireEvent.click(screen.getByRole("button", { name: /save changes/i }));
    await waitFor(() => {
      const call = fetchMock.mock.calls.find(([, init]) => (init as RequestInit | undefined)?.method === "PATCH");
      expect(JSON.parse(String((call![1] as RequestInit).body))).toMatchObject({ title: "Remote title!", baseHash: HASH_B });
    });
  });

  it("keeps the draft and offers reload when save returns 409 sync_stale without an event", async () => {
    let items = [{ ...sampleTask, title: "Ship release", baseHash: HASH_A }];
    let patchConflict = true;
    let failGet = false;
    const fetchMock = vi.fn(async (input: URL | RequestInfo, init?: RequestInit) => {
      const url = String(input);
      if (url === "/api/core/auth/me") return jsonResponse(AUTH_USER);
      if (url.includes("/summary")) return jsonResponse({ today: 1, overdue: 0, done: 0 });
      if (url.startsWith("/api/apps/tasks/tasks") && init?.method === "PATCH") {
        if (patchConflict) return jsonResponse({ error: { code: "sync_stale", message: "stale" } }, false, 409);
        return jsonResponse(items[0]);
      }
      if (url.startsWith("/api/apps/tasks/tasks")) {
        if (failGet) return jsonResponse({ error: { message: "offline" } }, false, 500);
        return jsonResponse({ items });
      }
      return jsonResponse(null, false, 404);
    });
    vi.stubGlobal("fetch", fetchMock);
    renderSignedInTasks();
    fireEvent.click(await screen.findByRole("button", { name: /edit task "ship release"/i }));
    await screen.findByTestId("task-editor");
    await waitFor(() => expect(fetchMock.mock.calls.some(([url]) => String(url) === "/api/core/auth/me")).toBe(true));
    fireEvent.change(screen.getByLabelText("Task title"), { target: { value: "Local draft" } });
    fireEvent.click(screen.getByRole("button", { name: /save changes/i }));
    expect(await screen.findByRole("button", { name: "Discard draft and reload" })).toBeTruthy();
    expect(screen.getByLabelText("Task title")).toHaveValue("Local draft");
    failGet = true;
    fireEvent.click(screen.getByRole("button", { name: "Discard draft and reload" }));
    await waitFor(() => expect(screen.getByLabelText("Task title")).toHaveValue("Local draft"));
    expect(screen.getByRole("button", { name: "Discard draft and reload" })).toBeTruthy();
    failGet = false;
    patchConflict = false;
    items = [{ ...sampleTask, title: "Remote title", baseHash: HASH_B }];
    fireEvent.click(screen.getByRole("button", { name: "Discard draft and reload" }));
    await waitFor(() => expect(screen.getByLabelText("Task title")).toHaveValue("Remote title"));
    expect(screen.queryByRole("button", { name: "Discard draft and reload" })).toBeNull();
    fireEvent.change(screen.getByLabelText("Task title"), { target: { value: "Remote title!" } });
    fireEvent.click(screen.getByRole("button", { name: /save changes/i }));
    await waitFor(() => {
      const patches = fetchMock.mock.calls.filter(([, init]) => (init as RequestInit | undefined)?.method === "PATCH");
      const last = patches[patches.length - 1];
      expect(JSON.parse(String((last![1] as RequestInit).body))).toMatchObject({ title: "Remote title!", baseHash: HASH_B });
    });
  });
});


describe("TasksTodayWidget density (Phase 10)", () => {
  const widget = TasksApp.widgets![0]!;
  const STATUS_URL = "/api/apps/tasks/public/status";

  const publicStatus = {
    current: { id: "t1", title: "Deep work", startAt: "2026-09-01T08:00:00.000Z" },
    next: { id: "t2", title: "Review PR", startAt: "2026-09-01T10:00:00.000Z" },
    today: { remainingCount: 2 },
  };

  function renderWidget(density: "compact" | "normal" | "expanded") {
    return render(
      <MemoryRouter>
        {widget.render({
          layout: { widthUnits: 20, heightUnits: 16, widthPx: 320, heightPx: 256, density },
        })}
      </MemoryRouter>,
    );
  }

  /** Fetch mock asserting which endpoints each density actually calls. */
  function setupDensityFetch(summary?: Record<string, number>) {
    const calls: string[] = [];
    const fetchMock = vi.fn(async (input: URL | RequestInfo) => {
      const url = String(input);
      calls.push(url);
      if (url === STATUS_URL) return jsonResponse(publicStatus);
      if (url.includes("/summary"))
        return jsonResponse(summary ?? { today: 4, overdue: 1, done: 7, doneToday: 3, overdueBeforeToday: 1 });
      return jsonResponse(null, false, 404);
    });
    vi.stubGlobal("fetch", fetchMock);
    return calls;
  }

  it("compact shows the running task and a one-line outlook, no counters", async () => {
    const calls = setupDensityFetch();
    renderWidget("compact");

    expect(await screen.findByText("Deep work")).toBeDefined();
    expect(screen.getByText("CURRENT")).toBeDefined();
    // next (1) + remainingCount (2).
    expect(screen.getByText("3 MORE TODAY")).toBeDefined();
    expect(screen.queryByText("Overdue")).toBeNull();
    expect(calls).not.toContain("/api/apps/tasks/summary");
  });

  it("normal shows the Today/Overdue/Done counters without the status block", async () => {
    const calls = setupDensityFetch();
    renderWidget("normal");

    expect(await screen.findByText("Today")).toBeDefined();
    expect(screen.getByText("Overdue")).toBeDefined();
    expect(screen.getByText("Done")).toBeDefined();
    expect(screen.queryByText("CURRENT")).toBeNull();
    expect(calls).not.toContain(STATUS_URL);
  });

  it("normal renders the today completion meter from disjoint summary segments", async () => {
    setupDensityFetch({ today: 4, overdue: 1, done: 7, doneToday: 3, overdueBeforeToday: 1 });
    const { container } = renderWidget("normal");

    expect(await screen.findByText("38%")).toBeDefined();
    // doneToday 3 of total 8 → round(0.375 * 10) = 4 lit segments.
    const meter = container.querySelector(".tasks-widget__progress .px-meter");
    expect(meter).not.toBeNull();
    expect(meter!.getAttribute("aria-label")).toBe("Today: 3 of 8 done");
    expect(meter!.querySelectorAll(".px-meter__seg--on")).toHaveLength(4);
  });

  it("keeps the meter silhouette with an explicit empty label when today has no tasks", async () => {
    setupDensityFetch({ today: 0, overdue: 0, done: 0, doneToday: 0, overdueBeforeToday: 0 });
    const { container } = renderWidget("normal");

    expect(await screen.findByText("Today")).toBeDefined();
    // Dashboard empty-state rule: zero-task days still render the ten hollow
    // segments plus a text label — never blank space, never a bare 0%.
    const meter = container.querySelector(".tasks-widget__progress .px-meter");
    expect(meter).not.toBeNull();
    expect(meter!.getAttribute("aria-label")).toBe("No tasks scheduled today");
    expect(meter!.querySelectorAll(".px-meter__seg--on")).toHaveLength(0);
    expect(screen.getByText("NO TASKS SCHEDULED")).toBeDefined();
  });

  it("expanded adds the current/next/remaining block on top of the counters", async () => {
    setupDensityFetch();
    renderWidget("expanded");

    expect(await screen.findByText("Today")).toBeDefined();
    expect(screen.getByText("CURRENT")).toBeDefined();
    expect(screen.getByText("Deep work")).toBeDefined();
    expect(screen.getByText("NEXT")).toBeDefined();
    expect(screen.getByText("Review PR")).toBeDefined();
    expect(screen.getByText("3 MORE TODAY")).toBeDefined();
  });

  it("declares its layout contract for the dashboard", () => {
    expect(widget.layout).toEqual({
      minW: 16,
      minH: 10,
      defaultW: 26,
      defaultH: 18,
      defaultOrder: 20,
      density: { normal: { minW: 18, minH: 12 }, expanded: { minW: 20, minH: 16 } },
    });
  });
});

describe("status provider (shell chips)", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("maps the summary today count to a chip, hidden at zero", async () => {
    let body: { today: number } = { today: 4 };
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse(body)));
    await expect(TasksApp.status!.load()).resolves.toEqual([
      { id: "today", label: "4", tone: "info", title: "4 tasks due today" },
    ]);

    body = { today: 0 };
    await expect(TasksApp.status!.load()).resolves.toEqual([]);
  });
});

function LanguageSwitch() {
  const { setLanguage } = useI18n();
  return <button onClick={() => setLanguage("en")}>Switch to English</button>;
}

it("switches task UI language without changing user titles, filters or an open draft", async () => {
  const fetchMock = setupFetch();
  render(<I18nProvider initialLanguage="zh"><MemoryRouter initialEntries={["/tasks?status=todo&priority=3"]}>
    {TasksApp.routes[0]!.element}<LanguageSwitch />
  </MemoryRouter></I18nProvider>);
  expect(await screen.findByText("Ship release")).toBeDefined();
  expect(screen.getByText("紧急", { selector: ".px-badge" })).toBeDefined();
  expect(screen.queryByText("管理个人任务、优先级与截止时间。")).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "帮助：关于任务" }));
  expect(screen.getByRole("dialog", { name: "关于任务" }).textContent).toContain("管理个人任务");
  fireEvent.click(screen.getByRole("button", { name: "关闭帮助" }));
  fireEvent.click(screen.getByRole("button", { name: "新建任务" }));
  fireEvent.change(screen.getByLabelText("任务标题"), { target: { value: "Draft 保留" } });
  fireEvent.change(screen.getByLabelText("优先级", { selector: "select" }), { target: { value: "2" } });
  fireEvent.click(screen.getByRole("button", { name: "Switch to English" }));
  expect((screen.getByLabelText("Task title") as HTMLInputElement).value).toBe("Draft 保留");
  expect((screen.getByLabelText("Priority", { selector: "select" }) as HTMLSelectElement).value).toBe("2");
  expect(screen.getByRole("button", { name: "Create task" })).toBeDefined();
  expect(screen.getByText("Ship release")).toBeDefined();
  expect(fetchMock.mock.calls.filter(([url]) => String(url).includes("/tasks?"))
    .every(([url]) => String(url).includes("status=todo") && String(url).includes("priority=3"))).toBe(true);
});
