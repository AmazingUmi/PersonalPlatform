import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { I18nProvider } from "./i18n";
import { useAsync } from "./useAsync";

afterEach(() => {
  cleanup();
});

function Probe({
  id,
  retain,
  load,
}: {
  id: string;
  retain?: boolean;
  load: (id: string) => Promise<{ id: string; title: string }>;
}) {
  const state = useAsync(() => load(id), [id], retain ? { retainOnReload: true } : undefined);
  return (
    <div>
      <p data-testid="id">{state.data?.id ?? "none"}</p>
      <p data-testid="title">{state.data?.title ?? "none"}</p>
      <p data-testid="loading">{String(state.loading)}</p>
      <p data-testid="error">{state.error ?? ""}</p>
      <button
        type="button"
        onClick={() => {
          void state.reload().then((ok) => {
            document.body.dataset.reloadOk = String(ok);
          });
        }}
      >
        reload
      </button>
    </div>
  );
}

describe("useAsync", () => {
  it("clears the previous record on a default reload and on an id change", async () => {
    const load = (id: string) => Promise.resolve({ id, title: id });
    const view = render(
      <I18nProvider>
        <Probe id="a" load={load} />
      </I18nProvider>,
    );
    await waitFor(() => expect(screen.getByTestId("id").textContent).toBe("a"));
    fireEvent.click(screen.getByRole("button", { name: "reload" }));
    expect(screen.getByTestId("id").textContent).toBe("none");
    expect(screen.getByTestId("loading").textContent).toBe("true");
    await waitFor(() => expect(screen.getByTestId("id").textContent).toBe("a"));
    view.rerender(
      <I18nProvider>
        <Probe id="b" load={load} />
      </I18nProvider>,
    );
    expect(screen.getByTestId("id").textContent).toBe("none");
    await waitFor(() => expect(screen.getByTestId("id").textContent).toBe("b"));
  });

  it("retains the same resource across reload and clears it when the id changes", async () => {
    const load = (id: string) => Promise.resolve({ id, title: `${id}-title` });
    const view = render(
      <I18nProvider>
        <Probe id="a" retain load={load} />
      </I18nProvider>,
    );
    await waitFor(() => expect(screen.getByTestId("title").textContent).toBe("a-title"));
    fireEvent.click(screen.getByRole("button", { name: "reload" }));
    expect(screen.getByTestId("title").textContent).toBe("a-title");
    expect(screen.getByTestId("loading").textContent).toBe("false");
    await waitFor(() => expect(document.body.dataset.reloadOk).toBe("true"));
    view.rerender(
      <I18nProvider>
        <Probe id="b" retain load={load} />
      </I18nProvider>,
    );
    expect(screen.getByTestId("id").textContent).toBe("none");
    await waitFor(() => expect(screen.getByTestId("id").textContent).toBe("b"));
  });

  it("ignores an out-of-order result after the id changes", async () => {
    const gates: Record<string, (value: { id: string; title: string }) => void> = {};
    const load = (id: string) =>
      new Promise<{ id: string; title: string }>((resolve) => {
        gates[id] = resolve;
      });
    const view = render(
      <I18nProvider>
        <Probe id="a" load={load} />
      </I18nProvider>,
    );
    await waitFor(() => expect(typeof gates.a).toBe("function"));
    view.rerender(
      <I18nProvider>
        <Probe id="b" load={load} />
      </I18nProvider>,
    );
    expect(screen.getByTestId("id").textContent).toBe("none");
    await waitFor(() => expect(typeof gates.b).toBe("function"));
    gates.a?.({ id: "a", title: "late-a" });
    expect(screen.getByTestId("id").textContent).toBe("none");
    gates.b?.({ id: "b", title: "b-title" });
    await waitFor(() => expect(screen.getByTestId("title").textContent).toBe("b-title"));
    expect(screen.getByTestId("id").textContent).toBe("b");
  });

  it("resolves a retained reload error as false and keeps the loaded record", async () => {
    let shouldFail = false;
    const load = (id: string) =>
      shouldFail ? Promise.reject(new Error("offline")) : Promise.resolve({ id, title: id });
    render(
      <I18nProvider>
        <Probe id="a" retain load={load} />
      </I18nProvider>,
    );
    await waitFor(() => expect(screen.getByTestId("title").textContent).toBe("a"));
    shouldFail = true;
    fireEvent.click(screen.getByRole("button", { name: "reload" }));
    await waitFor(() => expect(document.body.dataset.reloadOk).toBe("false"));
    expect(screen.getByTestId("title").textContent).toBe("a");
    expect(screen.getByTestId("id").textContent).toBe("a");
  });

  it("resolves a reload as false when unmounted before the next effect runs", async () => {
    const load = (id: string) => Promise.resolve({ id, title: id });
    const reloadRef: { current: (() => Promise<boolean>) | null } = { current: null };
    function UnmountProbe() {
      const state = useAsync(() => load("a"), ["a"]);
      reloadRef.current = state.reload;
      return <p data-testid="id">{state.data?.id ?? "none"}</p>;
    }
    const view = render(
      <I18nProvider>
        <UnmountProbe />
      </I18nProvider>,
    );
    await waitFor(() => expect(screen.getByTestId("id").textContent).toBe("a"));
    let settled: boolean | undefined;
    act(() => {
      void reloadRef.current?.().then((ok) => {
        settled = ok;
      });
      view.unmount();
    });
    await waitFor(() => expect(settled).toBe(false));
  });
});
