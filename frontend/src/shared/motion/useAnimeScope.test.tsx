import { describe, expect, it, vi, beforeEach } from "vitest";
import { renderHook } from "@testing-library/react";
import { createScope } from "animejs/scope";

vi.mock("animejs/scope", () => ({
  createScope: vi.fn(() => ({
    execute: (cb: () => unknown) => cb(),
    revert: vi.fn(),
  })),
}));

import { useAnimeScope } from "./useAnimeScope";

beforeEach(() => {
  vi.mocked(createScope).mockClear();
  vi.mocked(createScope).mockImplementation(
    () =>
      ({
        execute: (cb: () => unknown) => cb(),
        revert: vi.fn(),
      }) as unknown as ReturnType<typeof createScope>,
  );
});

const scopes = () =>
  vi.mocked(createScope).mock.results.map((r) => r.value as { revert: ReturnType<typeof vi.fn> });

describe("useAnimeScope", () => {
  it("creates a scope bound to the root ref and reverts on unmount", () => {
    const { result, unmount } = renderHook(() => {
      const root = { current: document.createElement("div") };
      const scope = useAnimeScope(root);
      return { root, scope };
    });
    expect(createScope).toHaveBeenCalledWith({ root: result.current.root });
    const handle = result.current.scope.current;
    expect(handle).not.toBeNull();

    const animation = { revert: vi.fn() };
    handle!.run(() => animation);
    expect(handle!.run(() => 42)).toBe(42);

    unmount();
    expect(animation.revert).toHaveBeenCalled();
  });

  it("reverts the underlying Anime.js scope", () => {
    const { unmount } = renderHook(() => {
      const root = { current: document.createElement("div") };
      return useAnimeScope(root);
    });
    unmount();
    expect(scopes().at(-1)?.revert).toHaveBeenCalled();
  });

  it("run() is a no-op after revert (stale callers during unmount)", () => {
    const { result, unmount } = renderHook(() => {
      const root = { current: document.createElement("div") };
      return useAnimeScope(root);
    });
    // result.current is the scope handle ref itself.
    const handle = result.current.current!;
    unmount();
    const animation = { revert: vi.fn() };
    expect(handle.run(() => animation)).toBeUndefined();
    expect(animation.revert).not.toHaveBeenCalled();
  });

  it("swallows errors thrown inside run()", () => {
    const { result } = renderHook(() => {
      const root = { current: document.createElement("div") };
      return useAnimeScope(root);
    });
    expect(() => result.current.current!.run(() => {
      throw new Error("boom");
    })).not.toThrow();
  });

  it("repeated mount/unmount cycles never accumulate animations", () => {
    const animations: Array<{ revert: ReturnType<typeof vi.fn> }> = [];
    const mount = () => {
      const rendered = renderHook(() => {
        const root = { current: document.createElement("div") };
        return useAnimeScope(root);
      });
      const handle = rendered.result.current.current!;
      const animation = { revert: vi.fn() };
      animations.push(animation);
      handle.run(() => animation);
      return rendered.unmount;
    };
    // Simulates the StrictMode mount → cleanup → mount cycle (and beyond):
    // every cycle reverts its own scope and animations before the next one.
    const firstUnmount = mount();
    firstUnmount();
    mount()();
    mount()();
    expect(createScope).toHaveBeenCalledTimes(3);
    expect(scopes().every((scope) => scope.revert.mock.calls.length === 1)).toBe(true);
    expect(animations.every((animation) => animation.revert.mock.calls.length === 1)).toBe(true);
  });
});
