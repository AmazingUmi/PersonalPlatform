import { useI18n } from "../../shared/i18n";
import { PixelWindow } from "../../shared/ui/PixelWindow";
import type { FocusState } from "./api";

/** Compact duration label: 8100 -> "2h 15m", 300 -> "5m", 45 -> "45s". */
export function secondsToHumanLabel(totalSeconds: number, language = "en"): string {
  const total = Math.max(0, Math.floor(totalSeconds));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;
  if (language === "zh") {
    if (hours >= 1) return `${hours}小时 ${minutes}分`;
    if (minutes >= 1) return `${minutes}分`;
    return `${seconds}秒`;
  }
  if (hours >= 1) return `${hours}h ${minutes}m`;
  if (minutes >= 1) return `${minutes}m`;
  return `${seconds}s`;
}

/** Today zone (APP-1 F07): focused time / rounds / sessions summary. */
export function FocusToday({ today }: { today: FocusState["today"] }) {
  const { t, language } = useI18n();
  return (
    <PixelWindow title={t("Today", "今天")} icon="check" className="focus-window">
      <div className="px-stats">
        <div className="px-stat">
          <span className="px-stat__label">{t("Focused", "专注时长")}</span>
          <span className="px-stat__value">{secondsToHumanLabel(today.focusedSeconds, language)}</span>
        </div>
        <div className="px-stat">
          <span className="px-stat__label">{t("Rounds", "轮次")}</span>
          <span className="px-stat__value">{today.completedRounds}</span>
        </div>
        <div className="px-stat">
          <span className="px-stat__label">{t("Sessions", "记录数")}</span>
          <span className="px-stat__value">{today.sessionsEnded}</span>
        </div>
      </div>
    </PixelWindow>
  );
}
