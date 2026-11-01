import { appName, appDescription } from "../shared/localizedMetadata";
import { localizeError } from "../shared/localizeError";
import { useI18n } from "../shared/i18n";
import { HelpPopover } from "../shared/ui/HelpPopover";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
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
import { listStagger } from "../shared/motion/pixelEntrance";
import { blink, pop } from "../shared/motion/pixelFeedback";
import { useAnimeScope } from "../shared/motion/useAnimeScope";

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
  const { t, language } = useI18n();
  const resolved = resolvePresentation(app, overrides, language);
  const current = overrides[app.id];
  const initialAccent =
    current?.accent !== undefined && ACCENT_OPTIONS.includes(current.accent as never)
      ? current.accent
      : "";
  const [name, setName] = useState(current?.displayName ?? "");
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
        title={t(`Customize ${app.name}`, `自定义${appName(app.id, app.name, language)}`)}
        icon="palette"
        accent={ACCENT_OPTIONS.includes(accent as never) ? (accent as PixelAccent) : resolved.accent}
        className="px-dialog px-dialog--form"
        data-testid="presentation-editor"
      >
        <form className="px-form" onSubmit={submit} aria-label={t(`Customize ${app.name}`, `自定义${appName(app.id, app.name, language)}`)}>
          <HelpPopover label={t("App identity", "应用标识")}>{t("Identity (id, route, version, capabilities) comes from the manifest and cannot change.", "应用标识、路由、版本和能力由应用定义，不能在此修改。")}</HelpPopover>
          <label className="px-form__row">
            <span className="px-form__label">{t("Nickname", "昵称")}</span>
            <PixelInput
              value={name}
              onChange={(e) => setName(e.target.value)}
              aria-label={t("App nickname", "应用昵称")}
              placeholder={appName(app.id, app.name, language)}
              autoFocus
            />
          </label>
          <label className="px-form__row">
            <span className="px-form__label">{t("Accent color", "强调色")}</span>
            <select
              className="px-select"
              value={accent}
              onChange={(e) => setAccent(e.target.value)}
              aria-label={t("Accent color", "强调色")}
            >
              <option value="">{t(`Default (${app.id})`, `默认（${app.id}）`)}</option>
              {ACCENT_OPTIONS.map((option) => (
                <option key={option} value={option}>
                  {({ primary: t("primary", "主色"), success: t("success", "成功色"), warning: t("warning", "警告色"), danger: t("danger", "危险色"), info: t("info", "信息色"), mint: t("mint", "薄荷绿"), yellow: t("yellow", "黄色"), violet: t("violet", "紫色"), coral: t("coral", "珊瑚色") })[option]}
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
              {reset.busy ? t("Resetting…", "正在重置…") : t("Reset to default", "恢复默认")}
            </PixelButton>
            <span className="app-card__foot-group">
              <PixelButton variant="secondary" size="sm" onClick={onClose} disabled={save.busy}>{t("Cancel", "取消")} </PixelButton>
              <PixelButton type="submit" size="sm" disabled={save.busy}>
                {save.busy ? t("Saving…", "正在保存…") : t("Save", "保存")}
              </PixelButton>
            </span>
          </div>
        </form>
      </PixelWindow>
    </div>
  );
}

/** Resolve an accent name to its CSS variable value (mirrors AppDock). */
function accentVar(accent: string | undefined): string {
  return `var(--px-${accent ?? "primary"})`;
}

/** App library (guide §20): responsive card grid generated from the app list.
 * Names/accents follow the resolved presentation (FP-6). Living-Desktop pass:
 * the grid reads as a software shelf — each card is a "box" (see apps.css),
 * with a real shelf summary under the page header. */
export function AppCenter({
  apps,
  presentation,
  onChanged,
}: {
  apps: AppInfo[];
  presentation?: PresentationOverrides;
  onChanged: () => void;
}) {
  const { t, language } = useI18n();
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [customizing, setCustomizing] = useState<AppInfo | null>(null);

  // Presentation-only motion; presets self-skip under reduced motion / jsdom.
  const gridRef = useRef<HTMLUListElement | null>(null);
  const motionScope = useAnimeScope(gridRef);
  /** First-paint stagger plays once per mount, never on later re-renders. */
  const entrancePlayedRef = useRef(false);

  useLayoutEffect(() => {
    if (entrancePlayedRef.current || apps.length === 0) return;
    entrancePlayedRef.current = true;
    const grid = gridRef.current;
    if (!grid) return;
    listStagger(grid.querySelectorAll(".app-card"), motionScope.current);
  }, [apps.length, motionScope]);

  /** Enable/disable success pulse; the first run only records the baseline. */
  const prevEnabledRef = useRef<Record<string, boolean> | null>(null);

  useEffect(() => {
    const grid = gridRef.current;
    const prev = prevEnabledRef.current;
    prevEnabledRef.current = Object.fromEntries(apps.map((app) => [app.id, app.enabled]));
    if (!prev || !grid) return;
    for (const app of apps) {
      if (prev[app.id] === undefined || prev[app.id] === app.enabled) continue;
      const card = grid.querySelector(`[data-app="${app.id}"]`);
      if (!card) continue;
      blink(card.querySelector(".app-card__icon"));
      pop(card.querySelector(".app-card__foot .px-badge"));
    }
  }, [apps, motionScope]);

  async function toggle(app: AppInfo, enabled: boolean) {
    setBusy(app.id);
    setError(null);
    try {
      await setAppEnabled(app.id, enabled);
      onChanged();
    } catch (err) {
      setError(err);
    } finally {
      setBusy(null);
    }
  }

  const overrides = presentation ?? {};
  const enabledCount = apps.filter((app) => app.status === "enabled").length;

  return (
    <div className="page">
      <header className="page-header">
        <h1 className="page-header__title">{t("App Center", "应用中心")}</h1>
        <HelpPopover label={t("App Center", "应用中心")}>{t("Install, enable and disable platform apps", "管理平台应用的启用和停用。")}</HelpPopover>
      </header>
      <p className="app-shelf-summary">
        {enabledCount} {t("of", "/")} {apps.length} {t("apps active on the shelf", "个应用已启用")} </p>
      {error !== null && (
        <StatusMessage tone="error">
          <p>{localizeError(error, language)}</p>
        </StatusMessage>
      )}
      <ul className="app-grid" ref={gridRef}>
        {apps.map((app) => {
          const resolved = resolvePresentation(app, overrides, language);
          return (
            <li
              key={app.id}
              className="app-card"
              data-app={app.id}
              data-status={app.status}
              style={{ "--app-accent": accentVar(resolved.accent) } as React.CSSProperties}
            >
              <div className="app-card__head">
                <span
                  className="app-card__icon"
                  aria-hidden="true"
                  data-accent={resolved.accent ?? ""}
                >
                  <PixelIcon name={appIconName(app.id)} size={20} />
                </span>
                <div className="app-card__meta">
                  <h2 className="app-card__name">{resolved.displayName}</h2>
                  <span className="app-card__version">
                    v{app.version}
                    {resolved.isCustomized ? t(" · customized", " · 已自定义") : ""}
                  </span>
                </div>
              </div>
              {app.description ? <HelpPopover label={resolved.displayName}>{appDescription(app.id, app.description, language)}</HelpPopover> : null}
              {app.status === "error" && app.enabled ? (
                <p className="app-card__intent">{t("Enable requested — activation failed.", "已请求启用，但启动失败。")}</p>
              ) : null}
              {app.errorMessage ? (
                <p className="app-card__error">
                  <PixelIcon name="warning" />
                  {app.errorMessage}
                </p>
              ) : null}
              <div className="app-card__foot">
                <span className="app-card__foot-group">
                  <PixelBadge tone={STATUS_TONES[app.status]}>{({ enabled: t("enabled", "已启用"), disabled: t("disabled", "已停用"), installed: t("installed", "已安装"), error: t("error", "错误") })[app.status]}</PixelBadge>
                  <PixelButton
                    variant="ghost"
                    size="sm"
                    aria-label={t(`Customize ${resolved.displayName}`, `自定义${resolved.displayName}`)}
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
                      {busy === app.id ? t("Working…", "处理中…") : t("Disable", "停用")}
                    </PixelButton>
                    <PixelButton
                      size="sm"
                      variant="primary"
                      disabled={busy === app.id}
                      onClick={() => void toggle(app, true)}
                    >
                      {busy === app.id ? t("Working…", "处理中…") : t("Retry", "重试")}
                    </PixelButton>
                  </span>
                ) : (
                  <PixelButton
                    size="sm"
                    variant={app.status === "enabled" ? "secondary" : "primary"}
                    disabled={busy === app.id || app.status === "installed"}
                    onClick={() => void toggle(app, app.status !== "enabled")}
                  >
                    {busy === app.id ? t("Working…", "处理中…") : app.status === "enabled" ? t("Disable", "停用") : t("Enable", "启用")}
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
