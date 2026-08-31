import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { DigitalClock } from "./DigitalClock";

/** Digital face rendering: 12/24h, seconds and date toggles, focus mode. */

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

afterEach(cleanup);

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
