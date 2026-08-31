import { cleanup, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it } from "vitest";
import { TaskStatusSection, type TaskStatusSlice } from "./TaskStatusSection";
import type { TasksPublicStatus } from "./tasksPublic";

/**
 * Task Status zone rendering from the public-status contract: current block
 * with elapsed, next block with countdown, remaining-today summary link, and
 * graceful states for "tasks disabled" and "nothing scheduled".
 */

const NOW = new Date("2026-08-31T11:26:00Z");

function slice(data: TasksPublicStatus | null): TaskStatusSlice {
  return { data, loading: false, error: null, reload: () => undefined };
}

function renderSection(status: TaskStatusSlice): HTMLElement {
  const { container } = render(
    <MemoryRouter>
      <TaskStatusSection now={NOW} status={status} />
    </MemoryRouter>,
  );
  return container;
}

afterEach(cleanup);

describe("TaskStatusSection", () => {
  it("renders current, next and the remaining-today link with deep links", () => {
    const container = renderSection(
      slice({
        current: { id: "cur-1", title: "Writing docs", startAt: "2026-08-31T10:02:00.000Z" },
        next: { id: "next-1", title: "阅读论文", startAt: "2026-08-31T11:50:00.000Z" },
        today: { remainingCount: 5 },
      }),
    );

    expect(screen.getByText("CURRENT TASK")).toBeTruthy();
    expect(screen.getByText("Writing docs").getAttribute("href")).toBe("/tasks/cur-1");
    // 84 minutes elapsed → "1h 24m".
    expect(screen.getByText("Started 1h 24m ago")).toBeTruthy();

    expect(screen.getByText("NEXT")).toBeTruthy();
    const nextLink = screen.getByRole("link", { name: /阅读论文/ });
    expect(nextLink.getAttribute("href")).toBe("/tasks/next-1");
    // 24 minutes until start.
    expect(screen.getByText("Starts in 24m")).toBeTruthy();

    const more = screen.getByText("5 MORE TASKS TODAY →");
    expect(more.getAttribute("href")).toBe("/tasks");
    // The start time renders in browser-local wall time; derive the expectation
    // the same way instead of pinning a timezone-dependent literal.
    const localStart = new Date("2026-08-31T11:50:00.000Z");
    const expected = `${String(localStart.getHours()).padStart(2, "0")}:${String(localStart.getMinutes()).padStart(2, "0")}`;
    expect(container.textContent).toContain(expected);
  });

  it("hides the remaining link when there is nothing else today", () => {
    renderSection(
      slice({
        current: { id: "cur-1", title: "Solo", startAt: "2026-08-31T10:00:00.000Z" },
        next: null,
        today: { remainingCount: 0 },
      }),
    );
    expect(screen.queryByText(/MORE TASKS TODAY/)).toBeNull();
    expect(screen.getByText("Solo")).toBeTruthy();
  });

  it("null status (Tasks disabled) shows the unavailable state, not an error", () => {
    renderSection(slice(null));
    expect(screen.getByText("Tasks unavailable")).toBeTruthy();
    expect(screen.queryByText("CURRENT TASK")).toBeNull();
  });

  it("empty schedule shows the nothing-scheduled empty state", () => {
    renderSection(slice({ current: null, next: null, today: { remainingCount: 0 } }));
    expect(screen.getByText("Nothing scheduled")).toBeTruthy();
  });

  it("shows an error with retry when the fetch failed", () => {
    render(
      <MemoryRouter>
        <TaskStatusSection
          now={NOW}
          status={{ data: null, loading: false, error: "HTTP 500", reload: () => undefined }}
        />
      </MemoryRouter>,
    );
    expect(screen.getByText("HTTP 500")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Retry" })).toBeTruthy();
  });
});
