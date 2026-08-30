import { useState } from "react";
import { api } from "../../shared/api";
import { PixelButton } from "../../shared/ui/PixelButton";
import { PixelInput } from "../../shared/ui/PixelInput";
import { PixelWindow } from "../../shared/ui/PixelWindow";
import { StatusMessage } from "../../shared/ui/StatusMessage";
import { useMutation } from "../../shared/useMutation";
import type { FocusSettings } from "./api";

/** Minutes for the three durations; `longBreakInterval` is a round count. */
interface SettingsForm {
  focusMinutes: string;
  shortBreakMinutes: string;
  longBreakMinutes: string;
  longBreakInterval: string;
}

type FieldKey = keyof SettingsForm;

/** Bounds per the frozen F04 contract: minutes >= 1, interval 2..10. */
const FIELDS: Array<{ key: FieldKey; label: string; min: number; max: number | null }> = [
  { key: "focusMinutes", label: "Focus minutes", min: 1, max: null },
  { key: "shortBreakMinutes", label: "Short break minutes", min: 1, max: null },
  { key: "longBreakMinutes", label: "Long break minutes", min: 1, max: null },
  { key: "longBreakInterval", label: "Rounds before long break", min: 2, max: 10 },
];

function fieldValue(form: SettingsForm, key: FieldKey): number {
  const value = Number(form[key]);
  return Number.isFinite(value) ? value : Number.NaN;
}

function formValid(form: SettingsForm): boolean {
  return FIELDS.every((field) => {
    const value = fieldValue(form, field.key);
    return value >= field.min && (field.max === null || value <= field.max);
  });
}

function formToPayload(form: SettingsForm): FocusSettings {
  return {
    focusDurationSeconds: Math.round(fieldValue(form, "focusMinutes")) * 60,
    shortBreakDurationSeconds: Math.round(fieldValue(form, "shortBreakMinutes")) * 60,
    longBreakDurationSeconds: Math.round(fieldValue(form, "longBreakMinutes")) * 60,
    longBreakInterval: Math.round(fieldValue(form, "longBreakInterval")),
  };
}

/** Settings zone (APP-1 F07): durations in minutes, PUT as seconds. */
export function FocusSettings({ settings, onSaved }: { settings: FocusSettings; onSaved?: () => void }) {
  const [form, setForm] = useState<SettingsForm>(() => ({
    focusMinutes: String(Math.round(settings.focusDurationSeconds / 60)),
    shortBreakMinutes: String(Math.round(settings.shortBreakDurationSeconds / 60)),
    longBreakMinutes: String(Math.round(settings.longBreakDurationSeconds / 60)),
    longBreakInterval: String(settings.longBreakInterval),
  }));
  const [saved, setSaved] = useState(false);

  const set = (key: FieldKey, value: string) => {
    setSaved(false);
    setForm((current) => ({ ...current, [key]: value }));
  };

  // NOTE: settings are read once at mount on purpose — the 15s background
  // poll replaces the state object, and re-syncing would clobber user edits.
  const save = useMutation(async () => {
    await api<FocusSettings>("/api/apps/focus/settings", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(formToPayload(form)),
    });
  });

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!formValid(form) || save.busy) return;
    if (await save.mutate()) {
      setSaved(true);
      onSaved?.();
    }
  };

  return (
    <PixelWindow title="Settings" icon="settings" className="focus-window">
      <form className="px-form" onSubmit={submit} aria-label="Focus settings">
        <div className="px-form__grid">
          {FIELDS.map((field) => (
            <label key={field.key} className="px-form__row">
              <span className="px-form__label">{field.label}</span>
              <PixelInput
                type="number"
                min={field.min}
                max={field.max ?? undefined}
                step={1}
                inputMode="numeric"
                value={form[field.key]}
                onChange={(event) => set(field.key, event.target.value)}
                aria-label={field.label}
              />
            </label>
          ))}
        </div>
        {save.error ? (
          <StatusMessage tone="error">
            <p>{save.error}</p>
          </StatusMessage>
        ) : saved ? (
          <StatusMessage tone="success">
            <p>Settings saved</p>
          </StatusMessage>
        ) : null}
        <div className="focus-controls">
          <PixelButton type="submit" disabled={!formValid(form) || save.busy}>
            {save.busy ? "Saving…" : "Save"}
          </PixelButton>
        </div>
      </form>
    </PixelWindow>
  );
}
