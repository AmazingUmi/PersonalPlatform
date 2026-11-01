import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { EmptyState } from "./EmptyState";
import { HelpPopover } from "./HelpPopover";
import { PixelWindow } from "./PixelWindow";

/** The trigger sits beside visible anchor text and outside headings, labels, links, and buttons. */
function expectAnchored(helpName: string, anchorText: string) {
  const help = screen.getByRole("button", { name: helpName });
  const parent = help.parentElement;
  expect(parent).not.toBeNull();
  expect(help.closest("h1, h2, h3, label, a")).toBeNull();
  expect(parent!.closest("button, a, label")).toBeNull();
  expect(parent!.querySelectorAll(":scope > .px-help")).toHaveLength(1);
  const anchor = [...parent!.children].find((element) => element !== help && (element.textContent ?? "").includes(anchorText));
  expect(anchor).toBeTruthy();
  expect(anchor!.textContent?.trim().length).toBeGreaterThan(0);
  return help;
}

describe("help anchor placement", () => {
  afterEach(() => { cleanup(); });

  it("places window help beside the heading and keeps the heading name", () => {
    render(
      <PixelWindow title="Data management" titleHelp={<HelpPopover label="About data backups">Format</HelpPopover>}>
        body
      </PixelWindow>,
    );
    expect(screen.getByRole("heading", { name: "Data management" })).toBeTruthy();
    const help = expectAnchored("Help: About data backups", "Data management");
    expect(screen.getByRole("heading", { name: "Data management" }).contains(help)).toBe(false);
    expect(document.querySelector(".px-window__actions .px-help")).toBeNull();
  });

  it("places empty-state help on the title row", () => {
    render(<EmptyState title="No notes yet" help={<HelpPopover label="Notes">Capture later</HelpPopover>} />);
    expect(screen.queryByText("Capture later")).toBeNull();
    expect(document.querySelector(".px-empty__desc")).toBeNull();
    expectAnchored("Help: Notes", "No notes yet");
    expect(screen.getByText("No notes yet")).toBeTruthy();
  });

  it("places field help outside the label that names the control", () => {
    render(
      <div>
        <span className="px-inline-help">
          <label htmlFor="webdav-endpoint">WebDAV folder URL</label>
          <HelpPopover label="Connection setup">How to connect</HelpPopover>
        </span>
        <input id="webdav-endpoint" />
      </div>,
    );
    expect(screen.getByLabelText("WebDAV folder URL")).toHaveAttribute("id", "webdav-endpoint");
    const help = expectAnchored("Help: Connection setup", "WebDAV folder URL");
    expect(help.closest("label")).toBeNull();
  });
});
