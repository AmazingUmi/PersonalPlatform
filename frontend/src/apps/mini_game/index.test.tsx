import { I18nProvider, useI18n } from "../../shared/i18n";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Game2048 } from "./index";

/**
 * FP-13.1: the game must not accept moves (or New Game) until the save
 * round-trip finishes, and a corrupted server board must never render.
 */

function key(keyName: string) {
  fireEvent.keyDown(window, { key: keyName });
}

function saveResponse(save: unknown) {
  return { ok: true, json: async () => ({ save }) };
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("Game2048 loading gate (FP-13.1)", () => {

  it("blocks moves and New Game while the save is loading, then enables them", async () => {
    let releaseSave: ((save: unknown) => void) | undefined;
    const loadingGate = new Promise<unknown>((resolve) => {
      releaseSave = resolve;
    });
    const fetchMock = vi
      .fn()
      .mockImplementationOnce(() => loadingGate.then((save) => saveResponse(save)))
      .mockImplementation(() => saveResponse(null));
    vi.stubGlobal("fetch", fetchMock);

    render(<Game2048 />);

    // Still loading: keyboard moves and New Game must be inert.
    expect(await screen.findByText("Loading save…")).toBeTruthy();
    key("ArrowLeft");
    key("w");
    expect(screen.queryByText("Saving…")).toBeNull();
    expect((screen.getByText("New Game") as HTMLButtonElement).disabled).toBe(true);

    // The save arrives with a real board; the game becomes interactive.
    releaseSave?.({
      score: 24,
      highScore: 220,
      revision: 3,
      board: [
        [2, 0, 0, 0],
        [0, 0, 0, 0],
        [0, 0, 0, 0],
        [0, 0, 0, 0],
      ],
    });
    await waitFor(() =>
      expect((screen.getByText("New Game") as HTMLButtonElement).disabled).toBe(false),
    );
    await waitFor(() => expect(screen.getByText("24")).toBeTruthy());
    expect(screen.queryByText("Loading save…")).toBeNull();

    // A move now triggers a save round-trip ([2,0,0,0] slid right moves).
    key("ArrowRight");
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
  });

  it("starts a fresh local run when the server board is corrupted", async () => {
    const fetchMock = vi
      .fn()
      .mockImplementationOnce(() =>
        saveResponse({
          score: 999,
          highScore: 999,
          revision: 9,
          board: [
            [3, 3, 3, 3],
            [3, 3, 3, 3],
            [3, 3, 3, 3],
            [3, 3, 3, 3],
          ],
        }),
      )
      .mockImplementation(() => saveResponse(null));
    vi.stubGlobal("fetch", fetchMock);

    render(<Game2048 />);
    // Fresh run: score resets to 0, New Game enabled, no corrupted "999".
    await waitFor(() =>
      expect((screen.getByText("New Game") as HTMLButtonElement).disabled).toBe(false),
    );
    expect(screen.getAllByText("0").length).toBeGreaterThan(0);
    expect(screen.queryByText("999")).toBeNull();
  });

  it("starts a fresh local run when loading fails", async () => {
    const fetchMock = vi.fn().mockRejectedValue(new Error("offline"));
    vi.stubGlobal("fetch", fetchMock);

    render(<Game2048 />);
    await waitFor(() =>
      expect((screen.getByText("New Game") as HTMLButtonElement).disabled).toBe(false),
    );
    expect(screen.getAllByText("0").length).toBeGreaterThan(0);
  });
});

function LanguageSwitch() {
  const { language, setLanguage } = useI18n();
  return <button onClick={() => setLanguage(language === "en" ? "zh" : "en")}>Switch language</button>;
}

it("translates controls and help without reloading the saved board", async () => {
  const fetchMock = vi.fn(async () => saveResponse({ score: 24, highScore: 220, revision: 3, board: [[2, 0, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0]] }));
  vi.stubGlobal("fetch", fetchMock);
  const view = render(<I18nProvider initialLanguage="en"><LanguageSwitch /><Game2048 /></I18nProvider>);
  await screen.findByText("24");
  const before = view.container.querySelector(".game__tiles")?.innerHTML;
  fireEvent.click(screen.getByRole("button", { name: "Switch language" }));
  expect(screen.getByRole("button", { name: "新游戏" })).toBeEnabled();
  expect(screen.getByLabelText("最高分")).toHaveTextContent("220");
  expect(view.container.querySelector(".game__tiles")?.innerHTML).toBe(before);
  expect(fetchMock).toHaveBeenCalledTimes(1);
  expect(screen.queryByText("使用方向键或 WASD 移动方块。")).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "帮助：游戏说明" }));
  expect(screen.getByText("使用方向键或 WASD 移动方块。")).toBeVisible();
  cleanup();
  vi.unstubAllGlobals();
});

it("sends the later move with the hash returned by the earlier save", async () => {
  vi.spyOn(Math, "random").mockReturnValue(0);
  let releaseLoad: (value: { ok: boolean; json: () => Promise<unknown> }) => void = () => undefined;
  const loaded = new Promise<{ ok: boolean; json: () => Promise<unknown> }>((resolve) => {
    releaseLoad = resolve;
  });
  let release: (value: { ok: boolean; json: () => Promise<unknown> }) => void = () => undefined;
  const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
    if (!init?.method || init.method === "GET") return loaded;
    const puts = fetchMock.mock.calls.filter((call) => (call[1] as RequestInit | undefined)?.method === "PUT");
    if (puts.length === 1) return new Promise((resolve) => { release = resolve; });
    const payload = JSON.parse(String(init.body)) as { revision: number; baseHash?: string };
    return {
      ok: true,
      json: async () => ({
        accepted: true,
        baseHash: "c".repeat(64),
        save: { score: 0, highScore: 0, revision: payload.revision, board: [[0, 0, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0], [2, 0, 0, 0]] },
      }),
    };
  });
  vi.stubGlobal("fetch", fetchMock);
  const view = render(<Game2048 />);
  await act(async () => {
    releaseLoad({
      ok: true,
      json: async () => ({
        save: { score: 0, highScore: 0, revision: 1, board: [[2, 0, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0]] },
        baseHash: "a".repeat(64),
      }),
    });
  });
  expect(view.container.querySelector(".game__tile")).toHaveTextContent("2");
  expect(screen.getByRole("button", { name: "New Game" })).toBeEnabled();
  key("ArrowRight");
  key("ArrowDown");
  const puts = () => fetchMock.mock.calls.filter((call) => (call[1] as RequestInit | undefined)?.method === "PUT");
  expect(puts()).toHaveLength(1);
  await act(async () => {
    release({
      ok: true,
      json: async () => ({
        accepted: true,
        baseHash: "b".repeat(64),
        save: { score: 0, highScore: 0, revision: 2, board: [[0, 0, 0, 2], [0, 0, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0]] },
      }),
    });
  });
  expect(puts()).toHaveLength(2);
  const second = JSON.parse(String((puts()[1]![1] as RequestInit).body)) as { revision: number; baseHash?: string };
  expect(second.revision).toBe(3);
  expect(second.baseHash).toBe("b".repeat(64));
});

it("holds the visible board on a remote 409 and keeps it when reload fails", async () => {
  const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
    if (!init?.method || init.method === "GET") {
      if (fetchMock.mock.calls.filter((call) => !(call[1] as RequestInit | undefined)?.method || (call[1] as RequestInit).method === "GET").length > 1) {
        throw new Error("reload failed");
      }
      return {
        ok: true,
        json: async () => ({
          save: { score: 0, highScore: 0, revision: 1, board: [[2, 0, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0]] },
          baseHash: "a".repeat(64),
        }),
      };
    }
    return { ok: false, status: 409, json: async () => ({ error: { code: "sync_stale", message: "changed" } }) };
  });
  vi.stubGlobal("fetch", fetchMock);
  const view = render(<Game2048 />);
  await waitFor(() => expect((screen.getByRole("button", { name: "New Game" }) as HTMLButtonElement).disabled).toBe(false));
  key("ArrowRight");
  await screen.findByRole("button", { name: "Reload server board" });
  expect(fetchMock.mock.calls.filter((call) => (call[1] as RequestInit | undefined)?.method === "PUT")).toHaveLength(1);
  key("ArrowLeft");
  expect(fetchMock.mock.calls.filter((call) => (call[1] as RequestInit | undefined)?.method === "PUT")).toHaveLength(1);
  const held = view.container.querySelector(".game__tiles")?.innerHTML;
  fireEvent.click(screen.getByRole("button", { name: "Reload server board" }));
  await waitFor(() => expect(fetchMock.mock.calls.length).toBeGreaterThan(2));
  expect(view.container.querySelector(".game__tiles")?.innerHTML).toBe(held);
  cleanup();
  vi.unstubAllGlobals();
});
