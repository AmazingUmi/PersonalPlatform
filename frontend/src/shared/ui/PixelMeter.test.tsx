import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { PixelMeter } from "./PixelMeter";

/**
 * Segmented pixel meter (FE polish worklist): quantized segment math,
 * accessible label, and clamping for out-of-range values.
 */

afterEach(cleanup);

describe("PixelMeter", () => {
  it("renders filled segments rounded from the ratio", () => {
    const { container } = render(<PixelMeter value={3} max={4} label="3 of 4" />);
    const on = container.querySelectorAll(".px-meter__seg--on");
    expect(on).toHaveLength(8); // round(0.75 * 10)
    expect(container.querySelectorAll(".px-meter__seg")).toHaveLength(10);
  });

  it("carries the accessible label on role=img", () => {
    const { getByRole } = render(<PixelMeter value={1} max={2} label="1 of 2 done" />);
    expect(getByRole("img", { name: "1 of 2 done" })).toBeTruthy();
  });

  it("clamps out-of-range values instead of overflowing", () => {
    const { container } = render(<PixelMeter value={99} max={4} label="over" />);
    expect(container.querySelectorAll(".px-meter__seg--on")).toHaveLength(10);
    const empty = render(<PixelMeter value={-3} max={4} label="under" />);
    expect(empty.container.querySelectorAll(".px-meter__seg--on")).toHaveLength(0);
  });

  it("renders a custom segment count and accent attribute", () => {
    const { container } = render(<PixelMeter value={1} max={2} segments={4} accent="mint" label="x" />);
    expect(container.querySelectorAll(".px-meter__seg")).toHaveLength(4);
    expect(container.querySelector(".px-meter")!.getAttribute("data-accent")).toBe("mint");
  });
});
