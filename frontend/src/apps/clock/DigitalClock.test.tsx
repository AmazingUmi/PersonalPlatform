import type { ReactElement } from "react";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { tick } from "../../shared/motion/pixelFeedback";
import { DigitalClock } from "./DigitalClock";

/** Digital face rendering: 12/24h, seconds and date toggles, focus mode. */

vi.mock("../../shared/motion/pixelFeedback", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../shared/motion/pixelFeedback")>();
  return { ...actual, tick: vi.fn() };
});

const AUG_31_1926 = new Date(2026, 7, 31, 19, 26, 42);

function renderFace(
  settings: Partial<{ showSeconds: boolean; showDate: boolean; hourFormat: 12 | 24 }>,
  focus: Parameters<typeof DigitalClock>[0]["focus"] = null,
) {
  return render(
    <DigitalClock
      now={AUG_31_1926}
      settings={{ showSeconds: true, showDate: true, hourFormat: 24, ...settings }}
      variant="page"
      focus={focus}
    />,
  );
}

afterEach(() => {
  cleanup();
  vi.mocked(tick).mockClear();
});

describe("DigitalClock", () => {
  it("renders 24h time with seconds, weekday and date", () => {
    renderFace({});
    expect(screen.getByText("19")).toBeTruthy();
    expect(screen.getByText("26")).toBeTruthy();
    expect(screen.getByText("42")).toBeTruthy();
    expect(screen.getByText("MON")).toBeTruthy();
    expect(screen.getByText("AUG 31 · 2026")).toBeTruthy();
    expect(screen.getByText("CLOCK")).toBeTruthy();
    expect(screen.queryByText("PM")).toBeNull();
  });

  it("renders 12h time with a meridiem instead of a 24h hour", () => {
    renderFace({ hourFormat: 12 });
    expect(screen.getByText("07")).toBeTruthy();
    expect(screen.getByText("PM")).toBeTruthy();
    expect(screen.getByText("CLOCK")).toBeTruthy();
  });

  it("hides the seconds and the date line when disabled", () => {
    renderFace({ showSeconds: false, showDate: false });
    expect(screen.queryByText("42")).toBeNull();
    expect(screen.queryByText("AUG 31 · 2026")).toBeNull();
  });

  it("focus mode shows the FOCUS label and a running elapsed line", () => {
    const { container } = renderFace(
      {},
      { title: "Writing docs", startedAt: new Date(2026, 7, 31, 18, 2, 0).toISOString() },
    );
    expect(screen.getByText("FOCUS")).toBeTruthy();
    expect(screen.queryByText("CLOCK")).toBeNull();
    // 19:26:42 − 18:02:00 = 1h 24m 42s → "01:24" elapsed clock.
    expect(container.textContent).toContain("RUNNING · 01:24");
    expect(container.textContent).toContain("Writing docs");
  });
});

describe("DigitalClock digit tick (motion)", () => {
  const SETTINGS = { showSeconds: true, showDate: true, hourFormat: 24 } as const;

  function rerenderAt(view: { rerender: (ui: ReactElement) => void }, now: Date) {
    view.rerender(<DigitalClock now={now} settings={SETTINGS} variant="page" focus={null} />);
  }

  it("does not tick on initial mount", () => {
    renderFace({});
    expect(tick).not.toHaveBeenCalled();
  });

  it("ticks the seconds span when the seconds value changes between renders", () => {
    const view = render(<DigitalClock now={AUG_31_1926} settings={SETTINGS} variant="page" focus={null} />);
    expect(tick).not.toHaveBeenCalled();

    // 19:26:42 → 19:26:43: only the seconds group changes.
    rerenderAt(view, new Date(2026, 7, 31, 19, 26, 43));

    expect(tick).toHaveBeenCalledTimes(1);
    expect(tick).toHaveBeenCalledWith(view.container.querySelector(".clock-digital__seconds"));
  });

  it("ticks the minutes span too when the minute flips, but not the unchanged hour", () => {
    const view = render(<DigitalClock now={AUG_31_1926} settings={SETTINGS} variant="page" focus={null} />);

    // 19:26:42 → 19:27:00: minutes and seconds change, hours stays "19".
    rerenderAt(view, new Date(2026, 7, 31, 19, 27, 0));

    expect(tick).toHaveBeenCalledTimes(2);
    const targets = vi.mocked(tick).mock.calls.map(([target]) => target);
    expect(targets).toContain(view.container.querySelector(".clock-digital__seconds"));
    expect(targets).toContain(view.container.querySelectorAll(".clock-digital__digits")[1]);
    expect(targets).not.toContain(view.container.querySelectorAll(".clock-digital__digits")[0]);
  });
});
