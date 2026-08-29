import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
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

describe("Game2048 loading gate (FP-13.1)", () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

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
