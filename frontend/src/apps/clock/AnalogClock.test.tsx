import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { AnalogClock } from "./AnalogClock";

/**
 * Analog face: hand rotations reflect the pure handAngles math (hour hand
 * tracks minutes), the second hand is optional, and focus mode adds the ring.
 */

function renderFace(now: Date, showSeconds: boolean, focus: Parameters<typeof AnalogClock>[0]["focus"] = null) {
  return render(<AnalogClock now={now} settings={{ showSeconds }} variant="page" focus={focus} />);
}

afterEach(cleanup);

describe("AnalogClock", () => {
  it("rotates hands from the current time (3:15:30 → 97.75° / 93° / 180°)", () => {
    const { container } = renderFace(new Date(2026, 7, 31, 3, 15, 30), true);
    const hour = container.querySelector(".clock-analog__hand--hour")!.closest("g");
    const minute = container.querySelector(".clock-analog__hand--minute")!.closest("g");
    const second = container.querySelector(".clock-analog__hand--second")!.closest("g");
    expect(hour).toHaveAttribute("transform", "rotate(97.75 60 60)");
    expect(minute).toHaveAttribute("transform", "rotate(93 60 60)");
    expect(second).toHaveAttribute("transform", "rotate(180 60 60)");
  });

  it("hides the second hand when seconds are off", () => {
    const { container } = renderFace(new Date(2026, 7, 31, 3, 15, 30), false);
    expect(container.querySelector(".clock-analog__hand--second")).toBeNull();
    expect(container.querySelector(".clock-analog__hand--hour")).not.toBeNull();
  });

  it("renders all 60 tick marks, 12 of them major, plus the four numerals", () => {
    const { container } = renderFace(new Date(2026, 7, 31, 3, 15, 30), true);
    const ticks = container.querySelectorAll(".clock-analog__tick");
    expect(ticks).toHaveLength(60);
    expect(container.querySelectorAll(".clock-analog__tick--major")).toHaveLength(12);
    for (const numeral of ["12", "3", "6", "9"]) {
      expect(
        [...container.querySelectorAll(".clock-analog__numeral")].some((node) => node.textContent === numeral),
      ).toBe(true);
    }
  });

  it("focus mode adds the accent ring and the RUNNING line", () => {
    const idle = renderFace(new Date(2026, 7, 31, 3, 15, 30), true);
    expect(idle.container.querySelector(".clock-analog__ring")).toBeNull();
    cleanup();

    const focused = renderFace(
      new Date(2026, 7, 31, 3, 15, 30),
      true,
      { title: "Deep work", startedAt: new Date(2026, 7, 31, 3, 0, 0).toISOString() },
    );
    expect(focused.container.querySelector(".clock-analog__ring")).not.toBeNull();
    expect(focused.container.textContent).toContain("RUNNING · 15:30");
  });
});
