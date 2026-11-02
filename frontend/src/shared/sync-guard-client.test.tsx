import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { useRef, useState } from "react";
import { afterEach, describe, expect, it } from "vitest";
import { I18nProvider } from "./i18n";
import { SYNC_DATA_CHANGED } from "./sync";
import { SyncPendingNotice, retainLoadedHash, useSyncModelRefresh } from "./sync-guard-client";

function Harness({ dirty, userId }: { dirty: boolean; userId: string }) {
  const [server, setServer] = useState("original");
  const hash = useRef<string | undefined>("a".repeat(64));
  const sync = useSyncModelRefresh(dirty, () => setServer("refreshed"), userId);
  hash.current = retainLoadedHash(hash.current, "b".repeat(64), dirty || sync.pending);
  return (
    <div>
      <p data-testid="server">{server}</p>
      <p data-testid="hash">{hash.current ?? "none"}</p>
      <SyncPendingNotice pending={sync.pending} onReload={sync.reload} />
    </div>
  );
}

function emit(userId: string) {
  act(() => {
    window.dispatchEvent(new CustomEvent(SYNC_DATA_CHANGED, {
      detail: { userId, identityId: "replica-1", result: "committed", baseline: false, openConflicts: 0 },
    }));
  });
}

afterEach(() => {
  cleanup();
});

describe("sync model refresh", () => {
  it("refreshes a clean model and ignores another user", () => {
    render(<I18nProvider initialLanguage="en"><Harness dirty={false} userId="user-1" /></I18nProvider>);
    emit("user-2");
    expect(screen.getByTestId("server").textContent).toBe("original");
    expect(screen.queryByRole("button", { name: "Reload server data" })).toBeNull();
    emit("user-1");
    expect(screen.getByTestId("server").textContent).toBe("refreshed");
    expect(screen.getByTestId("hash").textContent).toBe("b".repeat(64));
  });

  it("keeps a dirty draft hash and shows an English reload action", () => {
    render(<I18nProvider initialLanguage="en"><Harness dirty userId="user-1" /></I18nProvider>);
    emit("user-1");
    expect(screen.getByTestId("server").textContent).toBe("original");
    expect(screen.getByTestId("hash").textContent).toBe("a".repeat(64));
    expect(screen.getByText("Server data changed. Your unsaved edits are kept.")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Reload server data" }));
    expect(screen.getByTestId("server").textContent).toBe("refreshed");
  });

  it("shows the Chinese pending copy", () => {
    render(<I18nProvider initialLanguage="zh"><Harness dirty userId="user-1" /></I18nProvider>);
    emit("user-1");
    expect(screen.getByText("服务器数据已更改。未保存的修改已保留。")).toBeTruthy();
    expect(screen.getByRole("button", { name: "重新加载服务器数据" })).toBeTruthy();
  });
});
