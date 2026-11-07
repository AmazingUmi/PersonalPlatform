import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { HelpPopover } from "./HelpPopover";
import { I18nProvider } from "../i18n";
afterEach(() => { cleanup(); vi.restoreAllMocks(); });
describe("question-mark help", () => {
  it("opens on hover, keeps links usable, and closes with Escape without reopening", async () => {
    render(<HelpPopover label="Backups"><a href="#details">Details</a><p>Explanation</p></HelpPopover>);
    expect(screen.queryByText("Explanation")).not.toBeInTheDocument();
    const trigger = screen.getByRole("button", { name: "Help: Backups" });
    fireEvent.mouseEnter(trigger);
    expect(screen.getByRole("dialog", { name: "Backups" })).toBeVisible();
    fireEvent.mouseLeave(trigger); fireEvent.mouseEnter(screen.getByRole("dialog"));
    screen.getByRole("link", { name: "Details" }).focus();
    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(trigger).toHaveFocus();
    await waitFor(() => expect(trigger).toHaveAttribute("aria-expanded", "false"));
  });
  it("supports focus and touch-click pinning without activating its parent card", async () => {
    const parent = vi.fn();
    render(<div onClick={parent}><HelpPopover label="Controls">Explanation</HelpPopover><button>Outside</button></div>);
    const trigger = screen.getByRole("button", { name: "Help: Controls" });
    fireEvent.focus(trigger);
    expect(screen.getByRole("dialog")).toBeVisible();
    fireEvent.click(trigger);
    await waitFor(() => expect(screen.getByRole("dialog")).toHaveFocus());
    fireEvent.click(screen.getByRole("dialog"));
    expect(parent).not.toHaveBeenCalled();
    fireEvent.pointerDown(screen.getByText("Outside"));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });
  it("keeps Escape dismissal through hover re-entry caused by removing the panel", async () => {
    render(<><HelpPopover label="Connection">Explanation</HelpPopover><button>Outside</button></>);
    const trigger = screen.getByRole("button", { name: "Help: Connection" });
    fireEvent.mouseEnter(trigger);
    fireEvent.click(trigger);
    await waitFor(() => expect(screen.getByRole("dialog")).toHaveFocus());
    // A clamped panel can cover its trigger while the pointer stays still.
    fireEvent.mouseLeave(trigger);
    fireEvent.mouseEnter(screen.getByRole("dialog"));
    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(trigger).toHaveFocus();
    // Removing the covering panel synthesizes mouse-enter on the trigger.
    fireEvent.mouseEnter(trigger);
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    // A subsequent real leave/re-entry begins a fresh hover interaction.
    fireEvent.mouseLeave(trigger);
    fireEvent.mouseEnter(trigger);
    expect(screen.getByRole("dialog")).toBeVisible();
    fireEvent.keyDown(document, { key: "Escape" });
    fireEvent.click(trigger);
    await waitFor(() => expect(screen.getByRole("dialog")).toHaveFocus());
    fireEvent.keyDown(document, { key: "Escape" });
    act(() => { screen.getByRole("button", { name: "Outside" }).focus(); trigger.focus(); });
    expect(screen.getByRole("dialog")).toBeVisible();
  });
  it("does not let a dismissed click's deferred focus steal a new hover panel", () => {
    let focusFrame: FrameRequestCallback | undefined;
    vi.spyOn(window, "requestAnimationFrame").mockImplementation(callback => { focusFrame = callback; return 1; });
    render(<HelpPopover label="Connection">Explanation</HelpPopover>);
    const trigger = screen.getByRole("button", { name: "Help: Connection" });
    fireEvent.click(trigger);
    fireEvent.keyDown(document, { key: "Escape" });
    expect(trigger).toHaveFocus();
    fireEvent.mouseLeave(trigger);
    fireEvent.mouseEnter(trigger);
    const hoverPanel = screen.getByRole("dialog");
    expect(hoverPanel).not.toHaveFocus();
    act(() => focusFrame?.(0));
    expect(hoverPanel).not.toHaveFocus();
    expect(trigger).toHaveFocus();
  });
  it("uses Chinese accessible controls and cleans up a portal on unmount", () => {
    const view = render(<I18nProvider initialLanguage="zh"><HelpPopover label="备份">说明</HelpPopover></I18nProvider>);
    fireEvent.click(screen.getByRole("button", { name: "帮助：备份" }));
    expect(screen.getByRole("button", { name: "关闭帮助" })).toBeVisible();
    view.unmount();
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });
});
