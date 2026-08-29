import type { AppInfo } from "./api";
import { appAccent } from "./ui/appIcons";
import type { PixelAccent } from "./ui/PixelWindow";

/**
 * User presentation overrides (FP-6): nickname + accent per app, stored in
 * core.settings under "apps.presentation". Manifest identity (id, route,
 * version, capabilities) is never modified at runtime.
 */
export const PRESENTATION_KEY = "apps.presentation";

/** Every accent the UI can render; override values must match this list. */
export const ACCENT_OPTIONS: PixelAccent[] = [
  "primary",
  "success",
  "warning",
  "danger",
  "info",
  "mint",
  "yellow",
  "violet",
  "coral",
];

export interface AppPresentationOverride {
  displayName?: string;
  accent?: string;
}

export type PresentationOverrides = Record<string, AppPresentationOverride>;

export interface ResolvedPresentation {
  displayName: string;
  accent: PixelAccent | undefined;
  /** True when any override field actually applies to this app. */
  isCustomized: boolean;
}

/** Validate an untrusted settings value into a clean overrides map. */
export function normalizeOverrides(value: unknown): PresentationOverrides {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return {};
  const result: PresentationOverrides = {};
  for (const [appId, raw] of Object.entries(value as Record<string, unknown>)) {
    if (typeof raw !== "object" || raw === null) continue;
    const entry: AppPresentationOverride = {};
    const displayName = (raw as { displayName?: unknown }).displayName;
    if (typeof displayName === "string" && displayName.trim().length > 0 && displayName.length <= 100) {
      entry.displayName = displayName.trim();
    }
    const accent = (raw as { accent?: unknown }).accent;
    if (typeof accent === "string" && ACCENT_OPTIONS.includes(accent as PixelAccent)) {
      entry.accent = accent;
    }
    if (Object.keys(entry).length > 0) result[appId] = entry;
  }
  return result;
}

/**
 * manifest defaults + user override = resolved presentation. One resolver for
 * App Center, Dock, Mobile Nav, Dashboard and app headers (FP-6.2).
 */
export function resolvePresentation(
  app: Pick<AppInfo, "id" | "name">,
  overrides: PresentationOverrides,
): ResolvedPresentation {
  const override = overrides[app.id] ?? {};
  const displayName = override.displayName ?? app.name;
  const defaultAccent = appAccent(app.id);
  const accent =
    override.accent !== undefined && ACCENT_OPTIONS.includes(override.accent as PixelAccent)
      ? (override.accent as PixelAccent)
      : defaultAccent;
  return {
    displayName,
    accent,
    isCustomized:
      (override.displayName !== undefined && override.displayName !== app.name) ||
      (override.accent !== undefined && override.accent !== defaultAccent),
  };
}
