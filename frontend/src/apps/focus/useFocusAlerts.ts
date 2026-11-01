import { useCallback, useEffect, useState } from "react";
import { kindLabel, type FocusHistoryItem } from "./api";

type AlertState = { sound: boolean; soundStatus: string; notifications: boolean; notificationStatus: string };
function notificationStatus(): string {
  if (!globalThis.isSecureContext || typeof Notification === "undefined") return "Browser notifications unavailable";
  return `Browser permission: ${Notification.permission}`;
}

/** One controller per authenticated user, shared by mounted page/widget observers.
 * No payloads leave this document and no preference is written to storage. */
class AlertController {
  state: AlertState = { sound: false, soundStatus: "Sound off", notifications: false, notificationStatus: notificationStatus() };
  listeners = new Set<() => void>();
  claimed = new Set<string>();
  context: AudioContext | null = null;
  audioEpoch = 0;
  permissionEpoch = 0;
  notices = new Set<Notification>();
  constructor(readonly userId: string) {}
  update(patch: Partial<AlertState>) {
    this.state = { ...this.state, ...patch };
    this.listeners.forEach((listener) => listener());
  }
  refreshPermission = () => {
    const status = notificationStatus();
    const allowed = status === "Browser permission: granted";
    this.update({ notificationStatus: status, notifications: this.state.notifications && allowed });
  };
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    this.refreshPermission();
    return () => {
      this.listeners.delete(listener);
      if (this.listeners.size) return;
      this.audioEpoch += 1;
      this.permissionEpoch += 1;
      const context = this.context;
      this.context = null;
      if (context) { context.onstatechange = null; try { void context.close().catch(() => {}); } catch { /* unsupported close */ } }
      this.notices.forEach((notice) => { try { notice.close(); } catch { /* browser may have removed it */ } });
      this.notices.clear();
      this.update({ sound: false, soundStatus: "Sound off" });
    };
  };
  chime() {
    const context = this.context;
    try {
      if (!context || context.state !== "running") throw new Error("inactive audio");
      const oscillator = context.createOscillator();
      const gain = context.createGain();
      oscillator.connect(gain);
      gain.connect(context.destination);
      oscillator.frequency.setValueAtTime(880, context.currentTime);
      gain.gain.setValueAtTime(0.12, context.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.001, context.currentTime + 0.45);
      oscillator.onended = () => { oscillator.disconnect(); gain.disconnect(); };
      oscillator.start();
      oscillator.stop(context.currentTime + 0.5);
      return true;
    } catch {
      this.update({ sound: false, soundStatus: "Sound unavailable — use Enable sound to retry" });
      return false;
    }
  }
  enableSound = () => {
    const generation = ++this.audioEpoch;
    try {
      if (typeof AudioContext === "undefined") throw new Error("unsupported audio");
      this.context ??= new AudioContext();
      // Called directly in a button gesture, before any awaited work.
      const context = this.context;
      context.onstatechange = () => {
        if (this.context === context && context.state !== "running") {
          this.update({ sound: false, soundStatus: "Sound inactive — use Enable sound to retry" });
        }
      };
      const resumed = context.resume();
      this.update({ soundStatus: "Activating sound…" });
      void resumed.then(() => {
        if (generation !== this.audioEpoch || !this.listeners.size) return;
        if (context.state !== "running") throw new Error("audio suspended");
        this.update({ sound: true, soundStatus: "Sound ready" });
      }).catch(() => {
        if (generation === this.audioEpoch) this.update({ sound: false, soundStatus: "Sound unavailable — use Enable sound to retry" });
      });
    } catch {
      this.update({ sound: false, soundStatus: "Sound unavailable in this browser" });
    }
  };
  muteSound = () => {
    this.audioEpoch += 1;
    this.update({ sound: false, soundStatus: "Sound off" });
  };
  testSound = () => { this.chime(); };
  enableNotifications = () => {
    if (!globalThis.isSecureContext || typeof Notification === "undefined") {
      this.update({ notifications: false, notificationStatus: "Browser notifications unavailable" });
      return;
    }
    const generation = ++this.permissionEpoch;
    try {
      // Permission is only requested by this explicit control.
      void Notification.requestPermission().then((permission) => {
        if (generation !== this.permissionEpoch || !this.listeners.size) return;
        this.update({ notifications: permission === "granted", notificationStatus: `Browser permission: ${permission}` });
      }).catch(() => {
        if (generation === this.permissionEpoch) this.update({ notifications: false, notificationStatus: "Browser notification permission unavailable" });
      });
    } catch {
      this.update({ notifications: false, notificationStatus: "Browser notification permission unavailable" });
    }
  };
  disableNotifications = () => {
    this.permissionEpoch += 1;
    this.update({ notifications: false, notificationStatus: "Browser notifications off" });
  };
  announce = (session: FocusHistoryItem) => {
    if (!this.listeners.size || this.claimed.has(session.id)) return;
    this.claimed.add(session.id);
    if (this.claimed.size > 512) this.claimed.delete(this.claimed.values().next().value!);
    if (this.state.sound) this.chime();
    if (!this.state.notifications) return;
    try {
      if (!globalThis.isSecureContext || typeof Notification === "undefined" || Notification.permission !== "granted") {
        this.update({ notifications: false, notificationStatus: notificationStatus() });
        return;
      }
      const notice = new Notification(`${kindLabel(session.kind)} complete`, {
        body: "Your timer has finished. Open Focus when you are ready for the next session.",
        tag: `focus:${this.userId}:${session.id}`,
      });
      this.notices.add(notice);
      notice.onclose = () => this.notices.delete(notice);
    } catch {
      this.update({ notifications: false, notificationStatus: "Browser notification could not be shown" });
    }
  };
}
const controllers = new Map<string, AlertController>();
function forUser(id: string) {
  let controller = controllers.get(id);
  if (!controller) {
    // Keep recent in-tab deduplication without retaining an unbounded user ledger.
    if (controllers.size >= 16) {
      const inactive = [...controllers].find(([, value]) => value.listeners.size === 0);
      if (inactive) controllers.delete(inactive[0]);
    }
    controller = new AlertController(id); controllers.set(id, controller);
  }
  return controller;
}

export function useFocusAlerts(userId: string | null) {
  const controller = userId ? forUser(userId) : null;
  const [, render] = useState(0);
  useEffect(() => {
    if (!controller) return;
    const unsubscribe = controller.subscribe(() => render((revision) => revision + 1));
    const refresh = () => { if (document.visibilityState === "visible") controller.refreshPermission(); };
    document.addEventListener("visibilitychange", refresh);
    return () => { document.removeEventListener("visibilitychange", refresh); unsubscribe(); };
  }, [controller]);
  const announce = useCallback((session: FocusHistoryItem) => controller?.announce(session), [controller]);
  return {
    ...(controller?.state ?? { sound: false, soundStatus: "Sound off", notifications: false, notificationStatus: "Sign in to enable alerts" }),
    enableSound: controller?.enableSound,
    muteSound: controller?.muteSound,
    testSound: controller?.testSound,
    enableNotifications: controller?.enableNotifications,
    disableNotifications: controller?.disableNotifications,
    announce,
  };
}
