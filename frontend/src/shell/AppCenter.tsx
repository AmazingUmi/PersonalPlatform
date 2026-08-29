import { useState } from "react";
import { putSetting, setAppEnabled, type AppInfo, type AppStatus } from "../shared/api";
import {
  ACCENT_OPTIONS,
  PRESENTATION_KEY,
  resolvePresentation,
  type PresentationOverrides,
} from "../shared/presentation";
import { PixelBadge, type BadgeTone } from "../shared/ui/PixelBadge";
import type { PixelAccent } from "../shared/ui/PixelWindow";
import { PixelButton } from "../shared/ui/PixelButton";
import { PixelIcon } from "../shared/ui/PixelIcon";
import { PixelInput } from "../shared/ui/PixelInput";
import { PixelWindow } from "../shared/ui/PixelWindow";
import { StatusMessage } from "../shared/ui/StatusMessage";
import { appIconName } from "../shared/ui/appIcons";
import { useMutation } from "../shared/useMutation";

const STATUS_TONES: Record<AppStatus, BadgeTone> = {
  enabled: "success",
  disabled: "neutral",
  error: "danger",
  installed: "info",
};

/** Nickname + accent editor (FP-6.3); identity fields are never editable. */
function PresentationEditor({
  app,
  overrides,
  onClose,
  onSaved,
}: {
  app: AppInfo;
  overrides: PresentationOverrides;
  onClose: () => void;
  onSaved: () => void;
}) {
  const resolved = resolvePresentation(app, overrides);
  const current = overrides[app.id];
  const initialAccent =
    current?.accent !== undefined && ACCENT_OPTIONS.includes(current.accent as never)
      ? current.accent
      : "";
  const [name, setName] = useState(resolved.isCustomized ? resolved.displayName : "");
  const [accent, setAccent] = useState<string>(initialAccent);

  const save = useMutation(async () => {
    const next: PresentationOverrides = { ...overrides };
    const entry = { ...next[app.id] };
    if (name.trim()) entry.displayName = name.trim();
    else delete entry.displayName;
    if (accent) entry.accent = accent;
    else delete entry.accent;
    if (Object.keys(entry).length > 0) next[app.id] = entry;
    else delete next[app.id];
    await putSetting(PRESENTATION_KEY, next);
  });

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (save.busy) return;
    if (await save.mutate()) onSaved();
  };

  const reset = useMutation(async () => {
    const next: PresentationOverrides = { ...overrides };
    delete next[app.id];
    await putSetting(PRESENTATION_KEY, next);
  });

  return (
    <div className="px-dialog-backdrop" role="presentation">
      <PixelWindow
        title={`Customize ${app.name}`}
        icon="palette"
        accent={ACCENT_OPTIONS.includes(accent as never) ? (accent as PixelAccent) : resolved.accent}
        className="px-dialog px-dialog--form"
        data-testid="presentation-editor"
      >
        <form className="px-form" onSubmit={submit} aria-label={`Customize ${app.name}`}>
          <p className="px-form__hint">
            Identity (id, route, version, capabilities) comes from the manifest and cannot change.
          </p>
          <label className="px-form__row">
            <span className="px-form__label">Nickname</span>
            <PixelInput
              value={name}
              onChange={(e) => setName(e.target.value)}
              aria-label="App nickname"
              placeholder={app.name}
              autoFocus
            />
          </label>
          <label className="px-form__row">
            <span className="px-form__label">Accent color</span>
            <select
              className="px-select"
              value={accent}
              onChange={(e) => setAccent(e.target.value)}
              aria-label="Accent color"
            >
              <option value="">Default ({String(app.id)})</option>
              {ACCENT_OPTIONS.map((option) => (
                <option key={option} value={option}>
                  {option}
                </option>
              ))}
            </select>
          </label>
          <span className="app-accent-swatch" aria-hidden="true" data-accent={(accent || resolved.accent) ?? ""} />
          {save.error || reset.error ? (
            <StatusMessage tone="error">
              <p>{save.error ?? reset.error}</p>
            </StatusMessage>
          ) : null}
          <div className="px-dialog__actions">
            <PixelButton
              variant="ghost"
              size="sm"
              onClick={async () => {
                if (await reset.mutate()) onSaved();
              }}
              disabled={reset.busy || !overrides[app.id]}
            >
              {reset.busy ? "Resetting…" : "Reset to default"}
            </PixelButton>
            <span className="app-card__foot-group">
              <PixelButton variant="secondary" size="sm" onClick={onClose} disabled={save.busy}>
                Cancel
              </PixelButton>
              <PixelButton type="submit" size="sm" disabled={save.busy}>
                {save.busy ? "Saving…" : "Save"}
              </PixelButton>
            </span>
          </div>
        </form>
      </PixelWindow>
    </div>
  );
}

/** App library (guide §20): responsive card grid generated from the app list.
 * Names/accents follow the resolved presentation (FP-6). */
export function AppCenter({
  apps,
  presentation,
  onChanged,
}: {
  apps: AppInfo[];
  presentation?: PresentationOverrides;
  onChanged: () => void;
}) {
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [customizing, setCustomizing] = useState<AppInfo | null>(null);

  async function toggle(app: AppInfo, enabled: boolean) {
    setBusy(app.id);
    setError(null);
    try {
      await setAppEnabled(app.id, enabled);
      onChanged();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  }

  const overrides = presentation ?? {};

  return (
    <div className="page">
      <header className="page-header">
        <h1 className="page-header__title">App Center</h1>
        <p className="page-header__subtitle">Install, enable and disable platform apps</p>
      </header>
      {error && (
        <StatusMessage tone="error">
          <p>{error}</p>
        </StatusMessage>
      )}
      <ul className="app-grid">
        {apps.map((app) => {
          const resolved = resolvePresentation(app, overrides);
          return (
            <li key={app.id} className="app-card" data-app={app.id}>
              <div className="app-card__head">
                <span
                  className="app-card__icon"
                  aria-hidden="true"
                  data-accent={resolved.accent ?? ""}
                >
                  <PixelIcon name={appIconName(app.id)} size={24} />
                </span>
                <div className="app-card__meta">
                  <h2 className="app-card__name">{resolved.displayName}</h2>
                  <span className="app-card__version">
                    v{app.version}
                    {resolved.isCustomized ? " · customized" : ""}
                  </span>
                </div>
              </div>
              {app.description ? <p className="app-card__desc">{app.description}</p> : null}
              {app.status === "error" && app.enabled ? (
                <p className="app-card__intent">Enable requested — activation failed.</p>
              ) : null}
              {app.errorMessage ? (
                <p className="app-card__error">
                  <PixelIcon name="warning" />
                  {app.errorMessage}
                </p>
              ) : null}
              <div className="app-card__foot">
                <span className="app-card__foot-group">
                  <PixelBadge tone={STATUS_TONES[app.status]}>{app.status}</PixelBadge>
                  <PixelButton
                    variant="ghost"
                    size="sm"
                    aria-label={`Customize ${resolved.displayName}`}
                    onClick={() => setCustomizing(app)}
                  >
                    <PixelIcon name="palette" />
                  </PixelButton>
                </span>
                {app.status === "error" ? (
                  <span className="app-card__foot-group">
                    <PixelButton
                      size="sm"
                      variant="secondary"
                      disabled={busy === app.id}
                      onClick={() => void toggle(app, false)}
                    >
                      {busy === app.id ? "Working…" : "Disable"}
                    </PixelButton>
                    <PixelButton
                      size="sm"
                      variant="primary"
                      disabled={busy === app.id}
                      onClick={() => void toggle(app, true)}
                    >
                      {busy === app.id ? "Working…" : "Retry"}
                    </PixelButton>
                  </span>
                ) : (
                  <PixelButton
                    size="sm"
                    variant={app.status === "enabled" ? "secondary" : "primary"}
                    disabled={busy === app.id || app.status === "installed"}
                    onClick={() => void toggle(app, app.status !== "enabled")}
                  >
                    {busy === app.id ? "Working…" : app.status === "enabled" ? "Disable" : "Enable"}
                  </PixelButton>
                )}
              </div>
            </li>
          );
        })}
      </ul>
      {customizing ? (
        <PresentationEditor
          app={customizing}
          overrides={overrides}
          onClose={() => setCustomizing(null)}
          onSaved={() => {
            setCustomizing(null);
            onChanged();
          }}
        />
      ) : null}
    </div>
  );
}
