import { HelpPopover } from "../../shared/ui/HelpPopover";
import { useI18n } from "../../shared/i18n";
import { useEffect, useId, useRef, useState } from "react";
import { api } from "../../shared/api";
import { useAsync } from "../../shared/useAsync";
import { useMutation } from "../../shared/useMutation";
import { ConfirmDialog } from "../../shared/ui/ConfirmDialog";
import { EmptyState } from "../../shared/ui/EmptyState";
import { LoadingState } from "../../shared/ui/LoadingState";
import { PixelBadge } from "../../shared/ui/PixelBadge";
import { PixelButton } from "../../shared/ui/PixelButton";
import { PixelInput } from "../../shared/ui/PixelInput";
import { PixelWindow } from "../../shared/ui/PixelWindow";
import { StatusMessage } from "../../shared/ui/StatusMessage";
import { useClockNow } from "./useClockNow";
import {
  WEEKDAY_LABELS,
  WEEKDAY_LABELS_ZH,
  formatRepeatLabel,
  nextAlarmOccurrence,
  parseAlarmTime,
  pad2,
} from "./timeMath";

export interface AlarmView {
  id: string;
  time: string;
  label: string;
  enabled: boolean;
  repeatDays: number[];
  createdAt: string;
  updatedAt: string;
}

const ALARMS_URL = "/api/apps/clock/alarms";

type PermissionState = "unsupported" | "default" | "granted" | "denied";

interface RingingAlarm {
  /** Fire identity — `<alarmId>:<occurrence instant>` — unique per alarm AND occurrence. */
  key: string;
  alarm: AlarmView;
}

/**
 * Alarm list + CRUD + in-app firing. Browser reality (documented in
 * apps/clock/README.md): alarms fire only while the Clock app is open —
 * detection runs on the local wall clock, and the Notification API is used
 * when the user has granted permission. One-shot alarms (no repeat days)
 * disable themselves after ringing. No sounds, no background workers.
 */
export function AlarmSection() {
  const { t, language } = useI18n();
  const alarms = useAsync(() => api<{ items: AlarmView[] }>(ALARMS_URL));
  const [editorFor, setEditorFor] = useState<AlarmView | null | undefined>(undefined);
  const [deleting, setDeleting] = useState<AlarmView | null>(null);
  const [ringing, setRinging] = useState<RingingAlarm[]>([]);
  const firedKeys = useRef<Set<string>>(new Set());
  const now = useClockNow(true);

  const [permission, setPermission] = useState<PermissionState>(() =>
    typeof Notification === "undefined" ? "unsupported" : Notification.permission,
  );

  const requestPermission = async () => {
    if (typeof Notification === "undefined") return;
    const result = await Notification.requestPermission();
    setPermission(result);
  };

  const remove = useMutation(async () => {
    if (!deleting) return;
    await api(`${ALARMS_URL}/${deleting.id}`, { method: "DELETE" });
  });

  const items = alarms.data?.items ?? [];

  // Fire detection: a 60s window after each alarm's local HH:MM. Runs on the
  // second tick while the app is open. The fire key is `<alarmId>:<occurrence>`:
  // the same occurrence of the same alarm fires at most once, but two
  // different alarms at the same HH:MM each fire on their own.
  useEffect(() => {
    for (const alarm of items) {
      if (!alarm.enabled) continue;
      const parsed = parseAlarmTime(alarm.time);
      if (!parsed) continue;
      const occurrence = new Date(now);
      occurrence.setHours(parsed.hours, parsed.minutes, 0, 0);
      const fireKey = `${alarm.id}:${occurrence.getTime()}`;
      const age = now.getTime() - occurrence.getTime();
      if (age < 0 || age >= 60_000 || firedKeys.current.has(fireKey)) continue;
      if (alarm.repeatDays.length > 0 && !alarm.repeatDays.includes(occurrence.getDay())) continue;
      firedKeys.current.add(fireKey);
      setRinging((current) => [...current, { key: fireKey, alarm }]);
      if (typeof Notification !== "undefined" && Notification.permission === "granted") {
        try {
          new Notification(`⏰ ${alarm.time} ${alarm.label || t("Alarm", "闹钟")}`, {
            tag: `clock-alarm-${fireKey}`,
          });
        } catch {
          // Some environments construct but reject; the in-app banner still rings.
        }
      }
      // One-shot alarms spend themselves (idempotent PATCH; a failure just
      // leaves it enabled — the firedKeys guard prevents re-ringing).
      if (alarm.repeatDays.length === 0) {
        void api(`${ALARMS_URL}/${alarm.id}`, {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ enabled: false }),
        })
          .then(alarms.reload)
          .catch(() => undefined);
      }
    }
  }, [now, items, t]);

  const toggle = async (alarm: AlarmView) => {
    try {
      await api(`${ALARMS_URL}/${alarm.id}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ enabled: !alarm.enabled }),
      });
    } finally {
      alarms.reload();
    }
  };

  const upcoming = computeNextAlarm(items, now, language);

  return (
    <div className="clock-alarms">
      {ringing.length > 0 ? (
        <div className="clock-alarms__ringing" role="alert">
          {ringing.map(({ key, alarm }) => (
            <StatusMessage key={key} tone="warning">
              <p className="clock-alarms__ring-line">
                <strong>⏰ {alarm.time}</strong> {alarm.label || t("Alarm", "闹钟")}
              </p>
              <PixelButton
                size="sm"
                variant="secondary"
                onClick={() => setRinging((current) => current.filter((entry) => entry.key !== key))}
              >
                {t("Dismiss", "关闭")}
              </PixelButton>
            </StatusMessage>
          ))}
        </div>
      ) : null}

      <div className="clock-alarms__meta">
        <span className="clock-alarms__next">
          {upcoming ? `${t("NEXT", "下一个")} · ${upcoming.label}` : t("NO ALARMS ARMED", "未启用闹钟")}
        </span>
        {permission === "default" ? (
          <PixelButton size="sm" variant="secondary" onClick={() => void requestPermission()}>
            {t("Enable notifications", "启用通知")}
          </PixelButton>
        ) : null}
        {permission === "denied" ? (
          <span className="clock-alarms__perm-note">{t("Notifications blocked — in-app only", "通知被阻止，仅提供应用内提醒")}</span>
        ) : null}
        {permission === "granted" ? <PixelBadge tone="success">{t("Notifications on", "通知已开启")}</PixelBadge> : null}
      </div>

      {alarms.loading ? <LoadingState label={t("Loading alarms…", "正在加载闹钟…")} /> : null}
      {alarms.error ? (
        <div className="widget-fallback">
          <StatusMessage tone="error">
            <p>{alarms.error}</p>
          </StatusMessage>
          <PixelButton size="sm" variant="secondary" onClick={alarms.reload}>
            {t("Retry", "重试")}
          </PixelButton>
        </div>
      ) : null}

      {!alarms.loading && !alarms.error && items.length === 0 ? (
        <EmptyState
          icon="clock"
          title={t("No alarms", "暂无闹钟")}
          help={<HelpPopover label={t("Alarms", "闹钟")}>{t("Add an alarm to get an in-app (and, if permitted, browser) alert.", "添加闹钟以接收应用内提醒；授权后也可接收浏览器通知。")}</HelpPopover>}
        />
      ) : null}

      {items.length > 0 ? (
        <ul className="clock-alarms__list">
          {items.map((alarm) => (
            <li key={alarm.id} className={alarm.enabled ? "clock-alarm" : "clock-alarm clock-alarm--off"}>
              <div className="clock-alarm__main">
                <span className="clock-alarm__time">{alarm.time}</span>
                <span className="clock-alarm__label">{alarm.label || t("Alarm", "闹钟")}</span>
                <span className="clock-alarm__repeat">{formatRepeatLabel(alarm.repeatDays, language)}</span>
              </div>
              <div className="clock-alarm__actions">
                <PixelButton
                  size="sm"
                  variant={alarm.enabled ? "primary" : "secondary"}
                  onClick={() => void toggle(alarm)}
                >
                  {alarm.enabled ? t("ON", "开启") : t("OFF", "关闭")}
                </PixelButton>
                <PixelButton size="sm" variant="secondary" onClick={() => setEditorFor(alarm)}>
                  {t("Edit", "编辑")}
                </PixelButton>
                <PixelButton
                  size="sm"
                  variant="danger"
                  onClick={() => setDeleting(alarm)}
                  aria-label={t(`Delete alarm ${alarm.time}`, `删除 ${alarm.time} 闹钟`)}
                >
                  {t("Del", "删除")}
                </PixelButton>
              </div>
            </li>
          ))}
        </ul>
      ) : null}

      <PixelButton size="sm" onClick={() => setEditorFor(null)}>
        {t("+ Add Alarm", "+ 添加闹钟")}
      </PixelButton>

      {editorFor !== undefined ? (
        <AlarmEditor
          alarm={editorFor}
          onClose={() => setEditorFor(undefined)}
          onSaved={() => {
            setEditorFor(undefined);
            alarms.reload();
          }}
        />
      ) : null}
      {deleting ? (
        <ConfirmDialog
          title={t("Delete alarm", "删除闹钟")}
          message={t(`Delete the ${deleting.time} alarm${deleting.label ? ` "${deleting.label}"` : ""}?`, `删除 ${deleting.time} 闹钟${deleting.label ? `“${deleting.label}”` : ""}？`)}
          busy={remove.busy}
          onCancel={() => setDeleting(null)}
          onConfirm={async () => {
            if (await remove.mutate()) {
              setDeleting(null);
              alarms.reload();
            }
          }}
        />
      ) : null}
    </div>
  );
}

/** "MON 07:30" label of the earliest armed alarm occurrence. Exported for
 * the module status provider (dock/top-bar next-alarm chip). */
export function computeNextAlarm(items: AlarmView[], now: Date, language = "en"): { label: string } | null {
  let best: { at: Date; alarm: AlarmView } | null = null;
  for (const alarm of items) {
    const at = nextAlarmOccurrence(alarm, now);
    if (at && (!best || at < best.at)) best = { at, alarm };
  }
  if (!best) return null;
  return {
    label: `${(language === "zh" ? WEEKDAY_LABELS_ZH : WEEKDAY_LABELS)[best.at.getDay()]} ${pad2(best.at.getHours())}:${pad2(best.at.getMinutes())}`,
  };
}

interface AlarmEditorProps {
  alarm: AlarmView | null;
  onClose: () => void;
  onSaved: () => void;
}

function AlarmEditor({ alarm, onClose, onSaved }: AlarmEditorProps) {
  const { t, language } = useI18n();
  const repeatLabelId = useId();
  const [time, setTime] = useState(alarm?.time ?? "07:30");
  const [label, setLabel] = useState(alarm?.label ?? "");
  const [repeatDays, setRepeatDays] = useState<number[]>(alarm?.repeatDays ?? [1, 2, 3, 4, 5]);
  const save = useMutation(async () => {
    if (!parseAlarmTime(time)) return; // guarded below; keeps mutation types simple
    // POST takes a non-nullable label, so an empty label is simply omitted
    // ("" is the column default); PATCH keeps null = "clear to ''".
    const trimmed = label.trim();
    const payload: Record<string, unknown> = { time, repeatDays };
    if (alarm) payload.label = trimmed || null;
    else if (trimmed) payload.label = trimmed;
    const body = JSON.stringify(payload);
    if (alarm) {
      await api(`${ALARMS_URL}/${alarm.id}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body,
      });
    } else {
      await api(ALARMS_URL, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body,
      });
    }
  });

  const toggleDay = (day: number) => {
    setRepeatDays((current) =>
      current.includes(day) ? current.filter((value) => value !== day) : [...current, day].sort((a, b) => a - b),
    );
  };

  const valid = parseAlarmTime(time) !== null;

  return (
    <div className="px-dialog-backdrop" role="presentation">
      <PixelWindow title={alarm ? t("Edit Alarm", "编辑闹钟") : t("New Alarm", "新闹钟")} icon="clock" className="px-dialog px-dialog--form">
        <form
          className="px-form"
          data-testid="alarm-editor"
          onSubmit={async (event) => {
            event.preventDefault();
            if (await save.mutate()) onSaved();
          }}
        >
          <div className="px-form__grid">
            <label className="px-form__row">
              <span className="px-form__label">{t("Time", "时间")}</span>
              <PixelInput
                type="time"
                value={time}
                onChange={(event) => setTime(event.target.value)}
                aria-label={t("Alarm time", "闹钟时间")}
                required
              />
            </label>
            <label className="px-form__row">
              <span className="px-form__label">{t("Label", "名称")}</span>
              <PixelInput
                type="text"
                value={label}
                maxLength={100}
                onChange={(event) => setLabel(event.target.value)}
                placeholder={t("Morning", "早晨")}
                aria-label={t("Alarm label", "闹钟名称")}
              />
            </label>
          </div>
          <fieldset className="px-form__row" aria-labelledby={repeatLabelId}>
            <legend className="px-form__label">
              <span className="px-inline-help">
                <span id={repeatLabelId}>{t("Repeat", "重复")}</span>
                <HelpPopover label={t("Repeat days", "重复日期")}>{t("No days selected = a one-shot alarm (disables itself after ringing).", "不选择重复日期时，闹钟只响一次，响铃后自动停用。")}</HelpPopover>
              </span>
            </legend>
            <div className="clock-alarms__days" role="group" aria-label={t("Repeat days", "重复日期")}>
              {(language === "zh" ? WEEKDAY_LABELS_ZH : WEEKDAY_LABELS).map((dayLabel, day) => (
                <button
                  key={day}
                  type="button"
                  className="px-seg__btn clock-alarms__day"
                  aria-pressed={repeatDays.includes(day)}
                  onClick={() => toggleDay(day)}
                >
                  {dayLabel}
                </button>
              ))}
            </div>
          </fieldset>
          {save.error ? (
            <StatusMessage tone="error">
              <p>{save.error}</p>
            </StatusMessage>
          ) : null}
          <div className="px-dialog__actions">
            <PixelButton variant="secondary" size="sm" onClick={onClose} disabled={save.busy}>
              {t("Cancel", "取消")}
            </PixelButton>
            <PixelButton type="submit" size="sm" disabled={!valid || save.busy}>
              {save.busy ? t("Saving…", "保存中…") : alarm ? t("Save changes", "保存修改") : t("Create alarm", "创建闹钟")}
            </PixelButton>
          </div>
        </form>
      </PixelWindow>
    </div>
  );
}
