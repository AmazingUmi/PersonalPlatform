import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { I18nProvider, LANGUAGE_STORAGE_KEY, useI18n } from "./i18n";
import { resolvePresentation } from "./presentation";
import { localizeError } from "./localizeError";
import { useAsync } from "./useAsync";
import { useMutation } from "./useMutation";
import { ApiError } from "./api";
function Probe() {
  const { language, locale, setLanguage, t } = useI18n();
  return <><output>{t("Settings", "设置")} {locale}</output><input aria-label="draft" /><button onClick={() => setLanguage(language === "en" ? "zh" : "en")}>Switch</button></>;
}
// Explicit browser storage isolates preferences from Node's optional Web Storage globals.
beforeEach(() => {
  const values = new Map<string, string>();
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { values.set(key, value); },
    removeItem: (key: string) => { values.delete(key); },
    clear: () => values.clear(),
  });
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); document.documentElement.lang = "en"; });
describe("interface language", () => {
  it("switches immediately without remounting drafts and persists across reloads", () => {
    const view = render(<I18nProvider initialLanguage="en"><Probe /></I18nProvider>);
    fireEvent.change(screen.getByLabelText("draft"), { target: { value: "My title 标题" } });
    fireEvent.click(screen.getByText("Switch"));
    expect(screen.getByText("设置 zh-CN")).toBeInTheDocument();
    expect(screen.getByLabelText("draft")).toHaveValue("My title 标题");
    expect(document.documentElement.lang).toBe("zh-CN");
    expect(window.localStorage.getItem(LANGUAGE_STORAGE_KEY)).toBe("zh");
    view.unmount(); render(<I18nProvider><Probe /></I18nProvider>);
    expect(screen.getByText("设置 zh-CN")).toBeInTheDocument();
  });
  it("uses browser Chinese when no valid preference exists and synchronizes tabs", () => {
    vi.spyOn(navigator, "language", "get").mockReturnValue("zh-TW");
    window.localStorage.setItem(LANGUAGE_STORAGE_KEY, "invalid");
    render(<I18nProvider><Probe /></I18nProvider>);
    expect(screen.getByText("设置 zh-CN")).toBeInTheDocument();
    fireEvent(window, new StorageEvent("storage", { key: LANGUAGE_STORAGE_KEY, newValue: "en" }));
    expect(screen.getByText("Settings en-US")).toBeInTheDocument();
    fireEvent(window, new StorageEvent("storage", { key: LANGUAGE_STORAGE_KEY, newValue: "arbitrary" }));
    expect(screen.getByText("Settings en-US")).toBeInTheDocument();
  });
  it("works with unavailable localStorage and defaults to English outside the provider", () => {
    vi.spyOn(window.localStorage, "getItem").mockImplementation(() => { throw new Error("blocked"); });
    vi.spyOn(window.localStorage, "setItem").mockImplementation(() => { throw new Error("blocked"); });
    const view = render(<I18nProvider initialLanguage="en"><Probe /></I18nProvider>);
    fireEvent.click(screen.getByText("Switch"));
    expect(screen.getByText("设置 zh-CN")).toBeInTheDocument();
    view.unmount(); render(<Probe />);
    expect(screen.getByText("Settings en-US")).toBeInTheDocument();
  });
  it("retranslates existing async errors without retrying requests or mutations", async () => {
    const load = vi.fn().mockRejectedValue(new ApiError("forbidden", 403, "forbidden", null));
    const mutate = vi.fn().mockRejectedValue(new ApiError("Invalid task interval", 400, "invalid_time_interval", null));
    function Errors() {
      const { setLanguage } = useI18n();
      const data = useAsync(load);
      const action = useMutation(mutate);
      return <><p>{data.error}</p><p>{action.error}</p><button onClick={() => void action.mutate()}>Fail</button><button onClick={() => setLanguage("zh")}>Chinese</button></>;
    }
    render(<I18nProvider initialLanguage="en"><Errors /></I18nProvider>);
    await screen.findByText("forbidden");
    fireEvent.click(screen.getByText("Fail"));
    await screen.findByText("Invalid task interval");
    fireEvent.click(screen.getByText("Chinese"));
    await waitFor(() => expect(screen.getByText("当前账号没有执行此操作的权限。")).toBeVisible());
    expect(screen.getByText("截止时间不能早于开始时间。")).toBeVisible();
    expect(load).toHaveBeenCalledOnce();
    expect(mutate).toHaveBeenCalledOnce();
  });

  it("localizes default metadata and known errors without translating user names or unknown diagnostics", () => {
    expect(resolvePresentation({ id: "tasks", name: "Tasks" }, {}, "zh").displayName).toBe("任务");
    expect(resolvePresentation({ id: "tasks", name: "Tasks" }, { tasks: { displayName: "My Tasks" } }, "zh").displayName).toBe("My Tasks");
    expect(resolvePresentation({ id: "custom", name: "Custom" }, {}, "zh").displayName).toBe("Custom");
    expect(localizeError(new ApiError("secret detail", 403, "forbidden", null), "zh")).toBe("当前账号没有执行此操作的权限。");
    expect(localizeError("unknown: user title", "zh")).toBe("unknown: user title");
  });
});
