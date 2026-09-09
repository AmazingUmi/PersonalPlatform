import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ClockPage } from "./ClockPage";
import type { ClockSettings } from "./useClockSettings";

/**
 * Hour-format control visibility (clock patch): 12/24H only applies to the
 * digital face — the analog face ignores hourFormat, so the control must not
 * render while analog is active (the saved value is kept for the switch back).
 */

const mockSettings = vi.hoisted(() => ({ current: null as ClockSettings | null }));

vi.mock("./useClockSettings", () => ({
  useClockSettings: () => ({
    settings: mockSettings.current ?? {
      displayMode: "digital",
      showSeconds: true,
      showDate: true,
      hourFormat: 24,
    },
    loading: false,
    error: null,
    saving: false,
    reload: vi.fn(),
    save: vi.fn().mockResolvedValue(true),
  }),
}));

vi.mock("./tasksPublic", () => ({
  fetchTasksPublicStatus: vi.fn().mockResolvedValue({ current: null, next: null, today: { remainingCount: 0 } }),
}));

vi.mock("./AlarmSection", () => ({ AlarmSection: () => <div data-testid="alarms-stub" /> }));
vi.mock("./WorldClockSection", () => ({ WorldClockSection: () => <div data-testid="world-stub" /> }));

beforeEach(() => {
  mockSettings.current = null;
});

afterEach(() => {
  cleanup();
});

describe("ClockPage hour-format control", () => {
  it("shows 24H/12H while the digital face is active", () => {
    mockSettings.current = { displayMode: "digital", showSeconds: true, showDate: true, hourFormat: 24 };
    render(<ClockPage />);
    expect(screen.getByRole("group", { name: "Hour format" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "24H" })).toBeInTheDocument();
  });

  it("hides 24H/12H in analog mode (the face has no numeral format)", () => {
    mockSettings.current = { displayMode: "analog", showSeconds: true, showDate: true, hourFormat: 12 };
    render(<ClockPage />);
    expect(screen.queryByRole("group", { name: "Hour format" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "24H" })).not.toBeInTheDocument();
    // The display-mode switch itself stays available in both modes.
    expect(screen.getByRole("group", { name: "Display mode" })).toBeInTheDocument();
  });

  it("keeps the display-mode switch functional in analog mode", () => {
    mockSettings.current = { displayMode: "analog", showSeconds: true, showDate: true, hourFormat: 24 };
    render(<ClockPage />);
    expect(screen.getByRole("button", { name: "DIGITAL" })).toBeInTheDocument();
    expect(fireEvent.click(screen.getByRole("button", { name: "ANALOG" }))).toBe(true);
  });
});
