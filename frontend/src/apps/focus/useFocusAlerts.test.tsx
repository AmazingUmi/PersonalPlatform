import { I18nProvider, useI18n } from "../../shared/i18n";
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useFocusAlerts } from "./useFocusAlerts";
import type { FocusHistoryItem } from "./api";
const session = { id: "done", kind: "focus" } as FocusHistoryItem;
let user = 0;
const permission = vi.fn();
const notification = vi.fn();
class MockNotification {
  static permission: NotificationPermission = "default";
  static requestPermission = permission;
  constructor(title: string, options: NotificationOptions) { notification(title, options); }
  close = vi.fn();
}
const resume = vi.fn(); const oscillatorStart = vi.fn(); const close = vi.fn(async () => {});
class MockAudio {
  state = "running";
  currentTime = 0;
  destination = {};
  resume = resume;
  close = close;
  createOscillator() { return { connect: vi.fn(), disconnect: vi.fn(), frequency: { setValueAtTime: vi.fn() }, start: oscillatorStart, stop: vi.fn() }; }
  createGain() { return { connect: vi.fn(), disconnect: vi.fn(), gain: { value: 1, cancelScheduledValues: vi.fn(), setValueAtTime: vi.fn(), linearRampToValueAtTime: vi.fn(), exponentialRampToValueAtTime: vi.fn() } }; }
}
beforeEach(() => {
  user++; vi.clearAllMocks(); resume.mockResolvedValue(undefined); MockNotification.permission = "default";
  permission.mockResolvedValue("granted"); notification.mockImplementation(() => {});
  vi.stubGlobal("isSecureContext", true); vi.stubGlobal("Notification", MockNotification); vi.stubGlobal("AudioContext", MockAudio);
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
function mount() { return renderHook(() => useFocusAlerts(`alerts-user-${user}`)); }

describe("optional Focus alerts", () => {
  for (const choice of ["granted", "denied", "default"] as const) {
    it(`requests permission only from explicit enable and reports ${choice}`, async () => {
      permission.mockResolvedValue(choice);
      const { result } = mount();
      expect(permission).not.toHaveBeenCalled();
      act(() => result.current.announce(session));
      expect(permission).not.toHaveBeenCalled();
      await act(async () => { result.current.enableNotifications?.(); });
      expect(permission).toHaveBeenCalledTimes(1);
      expect(result.current.notifications).toBe(choice === "granted");
      expect(result.current.notificationStatus).toContain(choice);
    });
  }
  for (const unavailable of ["missing", "insecure"] as const) {
    it(`handles ${unavailable} notification facilities without requesting permission`, () => {
      if (unavailable === "missing") vi.stubGlobal("Notification", undefined); else vi.stubGlobal("isSecureContext", false);
      const { result } = mount();
      act(() => result.current.enableNotifications?.());
      expect(permission).not.toHaveBeenCalled(); expect(result.current.notificationStatus).toMatch(/unavailable/);
    });
  }
  it("handles rejected permission and constructor failure without throwing", async () => {
    const { result } = mount();
    permission.mockRejectedValueOnce(new Error("denied API"));
    await act(async () => { result.current.enableNotifications?.(); });
    expect(result.current.notificationStatus).toContain("unavailable");
    await act(async () => { result.current.enableNotifications?.(); });
    MockNotification.permission = "granted"; notification.mockImplementation(() => { throw new Error("needs service worker"); });
    act(() => result.current.announce(session));
    expect(result.current.notificationStatus).toContain("could not be shown");
  });
  it("does not let a pending permission result undo disable or cross identities", async () => {
    let resolve!: (value: string) => void;
    permission.mockReturnValue(new Promise<string>((r) => { resolve = r; }));
    const { result } = mount();
    act(() => result.current.enableNotifications?.());
    act(() => result.current.disableNotifications?.());
    await act(async () => { resolve("granted"); });
    expect(result.current.notifications).toBe(false);
  });
  it("deduplicates external alerts across observers, repeated reports and same-tab remount", async () => {
    MockNotification.permission = "granted";
    const first = mount(); const second = mount();
    await act(async () => { first.result.current.enableNotifications?.(); first.result.current.enableSound?.(); });
    expect(resume).toHaveBeenCalledTimes(1);
    act(() => { first.result.current.announce(session); second.result.current.announce(session); });
    expect(notification).toHaveBeenCalledTimes(1); expect(oscillatorStart).toHaveBeenCalledTimes(1);
    expect(notification).toHaveBeenCalledWith("Focus complete", expect.objectContaining({ tag: `focus:alerts-user-${user}:done` }));
    first.unmount(); second.unmount(); expect(close).toHaveBeenCalledTimes(1);
    const remount = mount(); act(() => remount.result.current.announce(session));
    expect(notification).toHaveBeenCalledTimes(1);
    // The same session id for another authenticated user has a separate ledger.
    const different = renderHook(() => useFocusAlerts(`different-${user}`));
    await act(async () => { different.result.current.enableNotifications?.(); });
    act(() => different.result.current.announce(session));
    expect(notification).toHaveBeenCalledTimes(2);
  });
  it("enables/resumes audio synchronously in a gesture, tests it, and mutes completion", async () => {
    const { result } = mount();
    expect(resume).not.toHaveBeenCalled();
    await act(async () => { result.current.enableSound?.(); expect(resume).toHaveBeenCalledTimes(1); });
    expect(result.current.soundStatus).toBe("Sound ready");
    act(() => result.current.testSound?.()); expect(oscillatorStart).toHaveBeenCalledTimes(1);
    act(() => { result.current.muteSound?.(); result.current.announce(session); });
    expect(oscillatorStart).toHaveBeenCalledTimes(1);
  });
  it("shares volume within an account without enabling sound or changing another account", async () => {
    const first = mount(); const second = mount();
    const other = renderHook(() => useFocusAlerts(`other-volume-${user}`));
    expect(first.result.current.volume).toBe(60);
    act(() => first.result.current.setVolume?.(30));
    expect(second.result.current.volume).toBe(30);
    expect(other.result.current.volume).toBe(60);
    expect(resume).not.toHaveBeenCalled(); expect(permission).not.toHaveBeenCalled();
    expect(first.result.current.sound).toBe(false);
    await act(async () => { first.result.current.enableSound?.(); });
    act(() => { first.result.current.muteSound?.(); first.result.current.setVolume?.(0); });
    expect(first.result.current.sound).toBe(false);
    expect(second.result.current.volume).toBe(0);
    act(() => first.result.current.announce(session));
    expect(oscillatorStart).not.toHaveBeenCalled();
    first.unmount(); second.unmount();
    const remount = mount(); expect(remount.result.current.volume).toBe(0);
    expect(remount.result.current.sound).toBe(false);
  });
  it("bounds volume and ignores invalid input", () => {
    const { result } = mount();
    act(() => result.current.setVolume?.(200)); expect(result.current.volume).toBe(100);
    act(() => result.current.setVolume?.(-1)); expect(result.current.volume).toBe(0);
    act(() => result.current.setVolume?.(NaN)); expect(result.current.volume).toBe(0);
  });
  for (const failure of ["missing", "suspended", "rejected", "playback"] as const) {
    it(`contains ${failure} audio failures`, async () => {
      if (failure === "missing") vi.stubGlobal("AudioContext", undefined);
      if (failure === "suspended") vi.stubGlobal("AudioContext", class extends MockAudio { state = "suspended"; });
      if (failure === "rejected") resume.mockRejectedValueOnce(new Error("blocked"));
      if (failure === "playback") oscillatorStart.mockImplementationOnce(() => { throw new Error("device gone"); });
      const { result } = mount();
      await act(async () => { result.current.enableSound?.(); });
      if (failure === "playback") act(() => result.current.testSound?.());
      expect(result.current.sound).toBe(false); expect(result.current.soundStatus).toContain("unavailable");
    });
  }
});

it("updates alert language without resetting audio and uses it for subsequent notifications", async () => {
  MockNotification.permission = "granted";
  const { result } = renderHook(() => ({ alerts: useFocusAlerts(`localized-${user}`), i18n: useI18n() }), {
    wrapper: ({ children }) => <I18nProvider initialLanguage="en">{children}</I18nProvider>,
  });
  await act(async () => { result.current.alerts.enableNotifications?.(); result.current.alerts.enableSound?.(); });
  const announce = result.current.alerts.announce;
  act(() => result.current.i18n.setLanguage("zh"));
  expect(result.current.alerts.soundStatus).toBe("声音已就绪");
  expect(result.current.alerts.notificationStatus).toBe("浏览器权限：已允许");
  expect(result.current.alerts.announce).toBe(announce);
  expect(result.current.alerts.sound).toBe(true);
  expect(close).not.toHaveBeenCalled();
  expect(resume).toHaveBeenCalledTimes(1);
  act(() => result.current.alerts.announce(session));
  expect(notification).toHaveBeenCalledWith("专注完成", expect.objectContaining({ body: "计时已完成，准备好后打开专注，开始下一阶段。" }));
});
