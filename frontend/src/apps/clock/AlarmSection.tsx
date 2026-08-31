import { useEffect, useRef, useState } from "react";
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
          new Notification(`⏰ ${alarm.time} ${alarm.label || "Alarm"}`, {
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
  }, [now, items]);

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

  const upcoming = computeNextAlarm(items, now);

  return (
    <div className="clock-alarms">
      {ringing.length > 0 ? (
        <div className="clock-alarms__ringing" role="alert">
          {ringing.map(({ key, alarm }) => (
            <StatusMessage key={key} tone="warning">
              <p className="clock-alarms__ring-line">
                <strong>⏰ {alarm.time}</strong> {alarm.label || "Alarm"}
              </p>
              <PixelButton
                size="sm"
                variant="secondary"
                onClick={() => setRinging((current) => current.filter((entry) => entry.key !== key))}
              >
                Dismiss
              </PixelButton>
            </StatusMessage>
          ))}
        </div>
      ) : null}

      <div className="clock-alarms__meta">
        <span className="clock-alarms__next">
          {upcoming ? `NEXT · ${upcoming.label}` : "NO ALARMS ARMED"}
        </span>
        {permission === "default" ? (
          <PixelButton size="sm" variant="secondary" onClick={() => void requestPermission()}>
            Enable notifications
          </PixelButton>
        ) : null}
        {permission === "denied" ? (
          <span className="clock-alarms__perm-note">Notifications blocked — in-app only</span>
        ) : null}
        {permission === "granted" ? <PixelBadge tone="success">Notifications on</PixelBadge> : null}
      </div>

      {alarms.loading ? <LoadingState label="Loading alarms…" /> : null}
      {alarms.error ? (
        <div className="widget-fallback">
          <StatusMessage tone="error">
            <p>{alarms.error}</p>
          </StatusMessage>
          <PixelButton size="sm" variant="secondary" onClick={alarms.reload}>
            Retry
          </PixelButton>
        </div>
      ) : null}

      {!alarms.loading && !alarms.error && items.length === 0 ? (
        <EmptyState
          icon="clock"
          title="No alarms"
          description="Add an alarm to get an in-app (and, if permitted, browser) alert."
        />
      ) : null}

      {items.length > 0 ? (
        <ul className="clock-alarms__list">
          {items.map((alarm) => (
            <li key={alarm.id} className={alarm.enabled ? "clock-alarm" : "clock-alarm clock-alarm--off"}>
              <div className="clock-alarm__main">
                <span className="clock-alarm__time">{alarm.time}</span>
                <span className="clock-alarm__label">{alarm.label || "Alarm"}</span>
                <span className="clock-alarm__repeat">{formatRepeatLabel(alarm.repeatDays)}</span>
              </div>
              <div className="clock-alarm__actions">
                <PixelButton
                  size="sm"
                  variant={alarm.enabled ? "primary" : "secondary"}
                  onClick={() => void toggle(alarm)}
                >
                  {alarm.enabled ? "ON" : "OFF"}
                </PixelButton>
                <PixelButton size="sm" variant="secondary" onClick={() => setEditorFor(alarm)}>
                  Edit
                </PixelButton>
                <PixelButton
                  size="sm"
                  variant="danger"
                  onClick={() => setDeleting(alarm)}
                  aria-label={`Delete alarm ${alarm.time}`}
                >
                  Del
                </PixelButton>
              </div>
            </li>
          ))}
        </ul>
      ) : null}

      <PixelButton size="sm" onClick={() => setEditorFor(null)}>
        + Add Alarm
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
          title="Delete alarm"
          message={`Delete the ${deleting.time} alarm${deleting.label ? ` "${deleting.label}"` : ""}?`}
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

/** "MON 07:30" label of the earliest armed alarm occurrence. */
function computeNextAlarm(items: AlarmView[], now: Date): { label: string } | null {
  let best: { at: Date; alarm: AlarmView } | null = null;
  for (const alarm of items) {
    const at = nextAlarmOccurrence(alarm, now);
    if (at && (!best || at < best.at)) best = { at, alarm };
  }
  if (!best) return null;
  return {
    label: `${WEEKDAY_LABELS[best.at.getDay()]} ${pad2(best.at.getHours())}:${pad2(best.at.getMinutes())}`,
  };
}

interface AlarmEditorProps {
  alarm: AlarmView | null;
  onClose: () => void;
  onSaved: () => void;
}

function AlarmEditor({ alarm, onClose, onSaved }: AlarmEditorProps) {
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
      <PixelWindow title={alarm ? "Edit Alarm" : "New Alarm"} icon="clock" className="px-dialog px-dialog--form">
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
              <span className="px-form__label">Time</span>
              <PixelInput
                type="time"
                value={time}
                onChange={(event) => setTime(event.target.value)}
                aria-label="Alarm time"
                required
              />
            </label>
            <label className="px-form__row">
              <span className="px-form__label">Label</span>
              <PixelInput
                type="text"
                value={label}
                maxLength={100}
                onChange={(event) => setLabel(event.target.value)}
                placeholder="Morning"
                aria-label="Alarm label"
              />
            </label>
          </div>
          <fieldset className="px-form__row">
            <legend className="px-form__label">Repeat</legend>
            <div className="clock-alarms__days" role="group" aria-label="Repeat days">
              {WEEKDAY_LABELS.map((dayLabel, day) => (
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
            <p className="px-form__hint">No days selected = a one-shot alarm (disables itself after ringing).</p>
          </fieldset>
          {save.error ? (
            <StatusMessage tone="error">
              <p>{save.error}</p>
            </StatusMessage>
          ) : null}
          <div className="px-dialog__actions">
            <PixelButton variant="secondary" size="sm" onClick={onClose} disabled={save.busy}>
              Cancel
            </PixelButton>
            <PixelButton type="submit" size="sm" disabled={!valid || save.busy}>
              {save.busy ? "Saving…" : alarm ? "Save changes" : "Create alarm"}
            </PixelButton>
          </div>
        </form>
      </PixelWindow>
    </div>
  );
}
