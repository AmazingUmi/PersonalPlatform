import { useI18n } from "../../shared/i18n";
import { useCallback, useEffect, useRef, useState } from "react";
import { kindLabel, type FocusHistoryItem } from "./api";

type AlertState = { sound: boolean; volume: number; soundStatus: string; notifications: boolean; notificationStatus: string };
function notificationStatus(): string {
  if (!globalThis.isSecureContext || typeof Notification === "undefined") return "Browser notifications unavailable";
  return `Browser permission: ${Notification.permission}`;
}

/** One controller per authenticated user, shared by mounted page/widget observers.
 * No payloads leave this document and no preference is written to storage. */
class AlertController {
  state: AlertState = { sound: false, volume: 60, soundStatus: "Sound off", notifications: false, notificationStatus: notificationStatus() };
  listeners = new Set<() => void>();
  claimed = new Set<string>();
  context: AudioContext | null = null;
  outputGain: GainNode | null = null;
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
      this.outputGain?.disconnect();
      this.outputGain = null;
      if (context) { context.onstatechange = null; try { void context.close().catch(() => {}); } catch { /* unsupported close */ } }
      this.notices.forEach((notice) => { try { notice.close(); } catch { /* browser may have removed it */ } });
      this.notices.clear();
      this.update({ sound: false, soundStatus: "Sound off" });
    };
  };
  chime() {
    const context = this.context;
    try {
      if (!context || context.state !== "running" || !this.outputGain) throw new Error("inactive audio");
      const oscillator = context.createOscillator();
      const gain = context.createGain();
      oscillator.connect(gain);
      gain.connect(this.outputGain);
      const start = context.currentTime + 0.02;
      oscillator.frequency.setValueAtTime(880, start);
      gain.gain.setValueAtTime(0, context.currentTime);
      // Three distinct chimes over two seconds. The default master level of
      // 60% preserves the previous output peak (0.2 * 0.6 = 0.12).
      for (const offset of [0, 0.7, 1.4]) {
        const at = start + offset;
        gain.gain.setValueAtTime(0, at);
        gain.gain.linearRampToValueAtTime(0.2, at + 0.015);
        gain.gain.setValueAtTime(0.2, at + 0.18);
        gain.gain.exponentialRampToValueAtTime(0.001, at + 0.55);
        gain.gain.linearRampToValueAtTime(0, at + 0.6);
      }
      oscillator.onended = () => { oscillator.disconnect(); gain.disconnect(); };
      oscillator.start(start);
      oscillator.stop(start + 2);
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
      if (!this.outputGain) {
        this.outputGain = context.createGain();
        this.outputGain.gain.setValueAtTime(this.state.volume / 100, context.currentTime);
        this.outputGain.connect(context.destination);
      }
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
  setVolume = (value: number) => {
    if (!Number.isFinite(value)) return;
    const volume = Math.round(Math.max(0, Math.min(100, value)));
    this.update({ volume });
    const context = this.context;
    const gain = this.outputGain?.gain;
    if (context && gain) {
      try {
        // Smooth live adjustments without starting audio or changing mute state.
        const now = context.currentTime;
        const currentGain = gain.value;
        gain.cancelScheduledValues(now);
        gain.setValueAtTime(currentGain, now);
        gain.linearRampToValueAtTime(volume / 100, now + 0.02);
      } catch {
        this.update({ sound: false, soundStatus: "Sound unavailable — use Enable sound to retry" });
      }
    }
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
  announce = (session: FocusHistoryItem, language = "en") => {
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
      const notice = new Notification(language === "zh" ? `${kindLabel(session.kind, language)}完成` : `${kindLabel(session.kind)} complete`, {
        body: language === "zh" ? "计时已完成，准备好后打开专注，开始下一阶段。" : "Your timer has finished. Open Focus when you are ready for the next session.",
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
  const { language } = useI18n();
  const languageRef = useRef(language);
  languageRef.current = language;
  const controller = userId ? forUser(userId) : null;
  const [, render] = useState(0);
  useEffect(() => {
    if (!controller) return;
    const unsubscribe = controller.subscribe(() => render((revision) => revision + 1));
    const refresh = () => { if (document.visibilityState === "visible") controller.refreshPermission(); };
    document.addEventListener("visibilitychange", refresh);
    return () => { document.removeEventListener("visibilitychange", refresh); unsubscribe(); };
  }, [controller]);
  const announce = useCallback((session: FocusHistoryItem) => controller?.announce(session, languageRef.current), [controller]);
  const state = controller?.state ?? { sound: false, volume: 60, soundStatus: "Sound off", notifications: false, notificationStatus: "Sign in to enable alerts" };
  return {
    ...state,
    soundStatus: alertStatusLabel(state.soundStatus, language),
    notificationStatus: alertStatusLabel(state.notificationStatus, language),
    setVolume: controller?.setVolume,
    enableSound: controller?.enableSound,
    muteSound: controller?.muteSound,
    testSound: controller?.testSound,
    enableNotifications: controller?.enableNotifications,
    disableNotifications: controller?.disableNotifications,
    announce,
  };
}

function alertStatusLabel(status: string, language: string): string {
  const labels: Record<string, string> = {
    "Sound off": "声音已关闭",
    "Sound unavailable — use Enable sound to retry": "声音不可用，请点击“启用声音”重试",
    "Sound inactive — use Enable sound to retry": "声音未激活，请点击“启用声音”重试",
    "Activating sound…": "正在激活声音…",
    "Sound ready": "声音已就绪",
    "Sound unavailable in this browser": "当前浏览器不支持声音提醒",
    "Browser notifications unavailable": "浏览器通知不可用",
    "Browser permission: granted": "浏览器权限：已允许",
    "Browser permission: default": "浏览器权限：未设置",
    "Browser permission: denied": "浏览器权限：已拒绝",
    "Browser notification permission unavailable": "无法获取浏览器通知权限",
    "Browser notifications off": "浏览器通知已关闭",
    "Browser notification could not be shown": "无法显示浏览器通知",
    "Sign in to enable alerts": "登录后可启用提醒",
  };
  return language === "zh" ? labels[status] ?? status : status;
}
