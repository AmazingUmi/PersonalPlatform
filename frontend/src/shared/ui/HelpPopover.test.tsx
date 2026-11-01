import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
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
  it("uses Chinese accessible controls and cleans up a portal on unmount", () => {
    const view = render(<I18nProvider initialLanguage="zh"><HelpPopover label="备份">说明</HelpPopover></I18nProvider>);
    fireEvent.click(screen.getByRole("button", { name: "帮助：备份" }));
    expect(screen.getByRole("button", { name: "关闭帮助" })).toBeVisible();
    view.unmount();
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });
});
