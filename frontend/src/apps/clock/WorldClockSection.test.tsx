import { I18nProvider, useI18n } from "../../shared/i18n";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WorldClockSection, type WorldClockView } from "./WorldClockSection";
import { WORLD_CITY_PRESETS } from "./worldCities";

/**
 * City/timezone binding (clock patch): the add form is a single preset
 * dropdown — no free-text inputs — so a mismatched city/timezone pair can
 * never be submitted, and the POST body always carries the bound pair.
 */

function jsonResponse(body: unknown, ok = true, status = 200): Response {
  return { ok, status, json: async () => body } as unknown as Response;
}

let seq = 0;
function worldClock(city: string, timezone: string): WorldClockView {
  seq += 1;
  const iso = new Date(0).toISOString();
  return { id: `wc-${seq}`, city, timezone, sortOrder: seq, createdAt: iso, updatedAt: iso };
}

/** In-memory world-clock store + call recorder over the real endpoints. */
function stubWorldClockApi(initial: WorldClockView[]) {
  let items = initial.map((entry) => ({ ...entry }));
  const posts: { city?: string; timezone?: string }[] = [];
  const fetchMock = vi.fn(async (input: URL | RequestInfo, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    if (url === "/api/apps/clock/world-clocks" && method === "GET") {
      return jsonResponse({ items });
    }
    if (url === "/api/apps/clock/world-clocks" && method === "POST") {
      const body = JSON.parse(String(init?.body)) as { city: string; timezone: string };
      posts.push(body);
      items = [...items, worldClock(body.city, body.timezone)];
      return jsonResponse(body);
    }
    return jsonResponse(null, false, 404);
  });
  vi.stubGlobal("fetch", fetchMock);
  return { posts };
}

const addButton = () => screen.getByRole("button", { name: "+ Add City" });

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("WorldClockSection add form", () => {
  it("offers a bound city dropdown instead of free-text inputs", async () => {
    stubWorldClockApi([]);
    render(<WorldClockSection now={new Date("2026-09-09T12:00:00Z")} />);
    const select = await screen.findByRole("combobox", { name: "City and timezone" });
    // One option per preset (plus the placeholder).
    const options = withinOptions(select);
    expect(options).toHaveLength(WORLD_CITY_PRESETS.length + 1);
    // The old free-text inputs are gone.
    expect(screen.queryByRole("textbox", { name: "City name" })).not.toBeInTheDocument();
    expect(screen.queryByRole("textbox", { name: "IANA timezone" })).not.toBeInTheDocument();
    expect(addButton()).toBeDisabled();
  });

  it("submits the bound city/timezone pair from the selection", async () => {
    const { posts } = stubWorldClockApi([]);
    render(<WorldClockSection now={new Date("2026-09-09T12:00:00Z")} />);
    fireEvent.change(await screen.findByRole("combobox", { name: "City and timezone" }), {
      target: { value: "Asia/Tokyo" },
    });
    // Instructions are available on demand without submitting the form.
    expect(screen.queryByText("Binds Tokyo to Asia/Tokyo.")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Help: City timezone" }));
    expect(screen.getByText("Binds Tokyo to Asia/Tokyo.")).toBeInTheDocument();
    expect(addButton()).toBeEnabled();

    fireEvent.click(addButton());
    await waitFor(() => expect(posts).toHaveLength(1));
    expect(posts[0]).toEqual({ city: "Tokyo", timezone: "Asia/Tokyo" });
  });

  it("disables Add for a city that is already on the list", async () => {
    stubWorldClockApi([worldClock("Tokyo", "Asia/Tokyo")]);
    render(<WorldClockSection now={new Date("2026-09-09T12:00:00Z")} />);
    await screen.findByText("Tokyo");
    fireEvent.change(screen.getByRole("combobox", { name: "City and timezone" }), {
      target: { value: "Asia/Tokyo" },
    });
    expect(screen.getByText("Tokyo is already on the list.")).toBeInTheDocument();
    expect(addButton()).toBeDisabled();
  });

  it("still renders legacy free-text entries", async () => {
    stubWorldClockApi([worldClock("Hometown", "Europe/Berlin")]);
    render(<WorldClockSection now={new Date("2026-09-09T12:00:00Z")} />);
    expect(await screen.findByText("Hometown")).toBeInTheDocument();
    expect(screen.getByText("Europe/Berlin")).toBeInTheDocument();
  });
});

function withinOptions(select: HTMLElement): HTMLOptionElement[] {
  return Array.from(select.querySelectorAll("option"));
}

function LanguageSwitch() {
  const { language, setLanguage } = useI18n();
  return <button onClick={() => setLanguage(language === "en" ? "zh" : "en")}>Switch language</button>;
}

it("localizes built-in city names and controls while preserving custom names and stored pairs", async () => {
  const { posts } = stubWorldClockApi([worldClock("Home Tokyo", "Asia/Tokyo")]);
  render(<I18nProvider initialLanguage="zh"><LanguageSwitch /><WorldClockSection now={new Date("2026-09-09T12:00:00Z")} /></I18nProvider>);
  expect(await screen.findByText("Home Tokyo")).toBeVisible();
  expect(screen.getByRole("button", { name: "移除 Home Tokyo" })).toBeVisible();
  fireEvent.change(screen.getByRole("combobox", { name: "城市与时区" }), { target: { value: "Asia/Shanghai" } });
  expect(screen.getByRole("option", { name: "上海 · Asia/Shanghai" })).toBeVisible();
  fireEvent.click(screen.getByRole("button", { name: "Switch language" }));
  expect(screen.getByRole("combobox", { name: "City and timezone" })).toHaveValue("Asia/Shanghai");
  fireEvent.click(screen.getByRole("button", { name: "+ Add City" }));
  await waitFor(() => expect(posts).toEqual([{ city: "Shanghai", timezone: "Asia/Shanghai" }]));
});
