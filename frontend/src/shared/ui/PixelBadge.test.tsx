import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import type { PixelAccent } from "./PixelWindow";
import { PixelBadge, type BadgeTone } from "./PixelBadge";

afterEach(() => cleanup());

describe("PixelBadge", () => {
  it("passes an accent through as data-accent", () => {
    render(<PixelBadge accent="mint">Mint</PixelBadge>);

    const badge = screen.getByText("Mint");
    expect(badge.getAttribute("data-accent")).toBe("mint");
    // The tone class stays as the fallback dimension alongside the accent.
    expect(badge.className).toBe("px-badge px-badge--neutral");
  });

  it("supports every accent of the platform palette", () => {
    const accents: PixelAccent[] = [
      "primary",
      "success",
      "warning",
      "danger",
      "info",
      "mint",
      "yellow",
      "violet",
      "coral",
    ];
    render(
      <>
        {accents.map((accent) => (
          <PixelBadge key={accent} accent={accent}>
            {accent}
          </PixelBadge>
        ))}
      </>,
    );

    for (const accent of accents) {
      expect(screen.getByText(accent).getAttribute("data-accent")).toBe(accent);
    }
  });

  it("omits data-accent and keeps the tone class when no accent is given", () => {
    render(<PixelBadge tone="info">Info</PixelBadge>);

    const badge = screen.getByText("Info");
    expect(badge.hasAttribute("data-accent")).toBe(false);
    expect(badge.className).toBe("px-badge px-badge--info");
  });

  it("renders every tone without blowing up", () => {
    const tones: BadgeTone[] = ["neutral", "success", "warning", "danger", "info"];
    render(
      <>
        {tones.map((tone) => (
          <PixelBadge key={tone} tone={tone}>
            {tone}
          </PixelBadge>
        ))}
      </>,
    );

    for (const tone of tones) {
      expect(screen.getByText(tone).className).toBe(`px-badge px-badge--${tone}`);
    }
  });
});
