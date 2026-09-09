import { act, cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { usePulseOnChange } from "./usePulseOnChange";
import { pop } from "./pixelFeedback";

vi.mock("./pixelFeedback", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./pixelFeedback")>();
  return { ...actual, pop: vi.fn() };
});

/** Host component that re-renders with a new value like a stat would. */
function Host({ value }: { value: number }) {
  const ref = usePulseOnChange<number, HTMLSpanElement>(value);
  return (
    <span ref={ref} data-testid="value">
      {value}
    </span>
  );
}

afterEach(() => {
  cleanup();
  vi.mocked(pop).mockClear();
});

describe("usePulseOnChange", () => {
  it("pulses the element when the value changes", async () => {
    const { rerender } = render(<Host value={1} />);
    expect(pop).not.toHaveBeenCalled();

    await act(async () => {
      rerender(<Host value={2} />);
    });
    expect(pop).toHaveBeenCalledTimes(1);
    expect(pop).toHaveBeenCalledWith(expect.any(HTMLElement));
  });

  it("does not pulse when the value stays the same across re-renders", async () => {
    const { rerender } = render(<Host value={7} />);
    await act(async () => {
      rerender(<Host value={7} />);
      rerender(<Host value={7} />);
    });
    expect(pop).not.toHaveBeenCalled();
  });
});
