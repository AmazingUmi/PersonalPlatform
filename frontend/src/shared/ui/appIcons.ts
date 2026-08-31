/**
 * Per-app UI metadata (guide §20.1): icons and accents are defined on the
 * frontend side so the backend AppInfo schema stays untouched.
 */
import type { PixelAccent } from "./PixelWindow";
import type { IconName } from "./PixelIcon";

const APP_ICONS: Record<string, IconName> = {
  tasks: "tasks",
  assets: "box",
  mini_game: "game",
  focus: "focus",
  notes: "file",
  clock: "clock",
};

const APP_ACCENTS: Record<string, PixelAccent> = {
  tasks: "mint",
  assets: "yellow",
  mini_game: "violet",
  focus: "coral",
  notes: "info",
  clock: "warning",
};

export function appIconName(appId: string): IconName {
  return APP_ICONS[appId] ?? "apps";
}

export function appAccent(appId: string): PixelAccent | undefined {
  return APP_ACCENTS[appId];
}
