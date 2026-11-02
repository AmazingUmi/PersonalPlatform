import { useI18n } from "../../shared/i18n";
import { useEffect, useRef, useState } from "react";
import { api } from "../../shared/api";
import { PixelButton } from "../../shared/ui/PixelButton";
import { PixelInput } from "../../shared/ui/PixelInput";
import { PixelWindow } from "../../shared/ui/PixelWindow";
import { StatusMessage } from "../../shared/ui/StatusMessage";
import { useMutation } from "../../shared/useMutation";
import { SyncPendingNotice, armPendingIfSyncConflict, useSyncModelRefresh } from "../../shared/sync-guard-client";
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
const FIELDS: Array<{ key: FieldKey; label: string; labelZh: string; min: number; max: number | null }> = [
  { key: "focusMinutes", label: "Focus minutes", labelZh: "专注时长（分钟）", min: 1, max: null },
  { key: "shortBreakMinutes", label: "Short break minutes", labelZh: "短休息（分钟）", min: 1, max: null },
  { key: "longBreakMinutes", label: "Long break minutes", labelZh: "长休息（分钟）", min: 1, max: null },
  { key: "longBreakInterval", label: "Rounds before long break", labelZh: "长休息前轮数", min: 2, max: 10 },
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
export function FocusSettings({ settings, onSaved }: { settings: FocusSettings; onSaved?: () => Promise<boolean> | boolean | void }) {
  const { t } = useI18n();
  const [form, setForm] = useState<SettingsForm>(() => ({
    focusMinutes: String(Math.round(settings.focusDurationSeconds / 60)),
    shortBreakMinutes: String(Math.round(settings.shortBreakDurationSeconds / 60)),
    longBreakMinutes: String(Math.round(settings.longBreakDurationSeconds / 60)),
    longBreakInterval: String(settings.longBreakInterval),
  }));
  const [saved, setSaved] = useState(false);
  const [dirty, setDirty] = useState(false);
  const dirtyRef = useRef(false);
  const baseHash = useRef(settings.baseHash);
  const adopt = useRef(false);
  const writing = useRef(false);
  const typedDuringWrite = useRef(false);
  dirtyRef.current = dirty;
  const sync = useSyncModelRefresh(dirty, () => undefined);
  useEffect(() => {
    if (dirtyRef.current && !adopt.current) return;
    adopt.current = false;
    baseHash.current = settings.baseHash;
    setDirty(false);
    setForm({
      focusMinutes: String(Math.round(settings.focusDurationSeconds / 60)),
      shortBreakMinutes: String(Math.round(settings.shortBreakDurationSeconds / 60)),
      longBreakMinutes: String(Math.round(settings.longBreakDurationSeconds / 60)),
      longBreakInterval: String(settings.longBreakInterval),
    });
    sync.dismiss();
  }, [settings]);

  const set = (key: FieldKey, value: string) => {
    adopt.current = false;
    if (writing.current) typedDuringWrite.current = true;
    dirtyRef.current = true;
    setDirty(true);
    setSaved(false);
    setForm((current) => ({ ...current, [key]: value }));
  };

  const save = useMutation(async () => {
    writing.current = true;
    typedDuringWrite.current = false;
    try {
      const result = await api<FocusSettings>("/api/apps/focus/settings", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ ...formToPayload(form), ...(baseHash.current ? { baseHash: baseHash.current } : {}) }),
      });
      if (result.baseHash) baseHash.current = result.baseHash;
      if (!typedDuringWrite.current) {
        dirtyRef.current = false;
        setDirty(false);
        setForm({
          focusMinutes: String(Math.round(result.focusDurationSeconds / 60)),
          shortBreakMinutes: String(Math.round(result.shortBreakDurationSeconds / 60)),
          longBreakMinutes: String(Math.round(result.longBreakDurationSeconds / 60)),
          longBreakInterval: String(result.longBreakInterval),
        });
        sync.dismiss();
      }
    } catch (error) {
      armPendingIfSyncConflict(error, sync.markPending);
      throw error;
    } finally {
      writing.current = false;
    }
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
    <PixelWindow title={t("Settings", "设置")} icon="settings" className="focus-window">
      <SyncPendingNotice
        pending={sync.pending}
        discard={dirty}
        onReload={() => {
          adopt.current = true;
          void Promise.resolve(onSaved?.()).then((ok) => {
            if (ok === false) adopt.current = false;
          });
        }}
      />
      <form className="px-form" onSubmit={submit} aria-label={t("Focus settings", "专注设置")}>
        <div className="px-form__grid">
          {FIELDS.map((field) => (
            <label key={field.key} className="px-form__row">
              <span className="px-form__label">{t(field.label, field.labelZh)}</span>
              <PixelInput
                type="number"
                min={field.min}
                max={field.max ?? undefined}
                step={1}
                inputMode="numeric"
                value={form[field.key]}
                onChange={(event) => set(field.key, event.target.value)}
                aria-label={t(field.label, field.labelZh)}
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
            <p>{t("Settings saved", "设置已保存")}</p>
          </StatusMessage>
        ) : null}
        <div className="focus-controls">
          <PixelButton type="submit" disabled={!formValid(form) || save.busy}>
            {save.busy ? t("Saving…", "保存中…") : t("Save", "保存")}
          </PixelButton>
        </div>
      </form>
    </PixelWindow>
  );
}
