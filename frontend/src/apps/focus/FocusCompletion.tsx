import { useI18n } from "../../shared/i18n";
import { PixelButton } from "../../shared/ui/PixelButton";
import { kindLabel, type FocusHistoryItem } from "./api";
import type { useFocusAlerts } from "./useFocusAlerts";

type Alerts = ReturnType<typeof useFocusAlerts>;
export function FocusAlertControls({ alerts }: { alerts: Alerts }) {
  const { t } = useI18n();
  return (
    <div className="focus-alerts">
      <label className="focus-alerts__volume">
        <span>{t("Alert volume", "提醒音量")}</span>
        <input type="range" min="0" max="100" step="1" value={alerts.volume}
          onChange={(event) => alerts.setVolume?.(Number(event.currentTarget.value))}
          aria-valuetext={`${alerts.volume}%`} />
        <output>{alerts.volume}%</output>
      </label>
      <div className="focus-alerts__controls" aria-label={t("Completion alerts", "完成提醒")}>
        <PixelButton size="sm" variant="secondary" onClick={alerts.sound ? alerts.muteSound : alerts.enableSound}>
          {alerts.sound ? t("Mute sound", "静音") : t("Enable sound", "启用声音")}
        </PixelButton>
        <PixelButton size="sm" variant="secondary" disabled={!alerts.sound} onClick={alerts.testSound}>{t("Test sound", "测试声音")}</PixelButton>
        <PixelButton size="sm" variant="secondary" onClick={alerts.notifications ? alerts.disableNotifications : alerts.enableNotifications}>
          {alerts.notifications ? t("Disable notifications", "关闭通知") : t("Enable notifications", "启用通知")}
        </PixelButton>
      </div>
      <p className="focus-alerts__status" aria-live="polite">{alerts.soundStatus} · {alerts.notificationStatus}</p>
    </div>
  );
}

export function FocusCompletion({ completion, onDismiss, alerts, compact = false }: {
  completion: FocusHistoryItem | null;
  onDismiss: () => void;
  alerts: Alerts;
  compact?: boolean;
}) {
  const { t, language } = useI18n();
  return (
    <div className={compact ? "focus-alerts focus-alerts--compact" : "focus-alerts"}>
      <div className={completion ? "focus-completion" : undefined} role="status" aria-live="polite" aria-atomic="true">
        {completion ? (
          <div>
            <strong>{kindLabel(completion.kind, language)} {t("complete", "完成")}</strong>
            {!compact && <p>{t("Your session has finished. Start the next session when you are ready.", "本次计时已完成，准备好后开始下一阶段。")}</p>}
            <PixelButton size="sm" variant="secondary" onClick={onDismiss} aria-label={t("Dismiss completion", "关闭完成提醒")}>
              {compact ? "×" : t("Dismiss completion", "关闭完成提醒")}
            </PixelButton>
          </div>
        ) : null}
      </div>
      {!compact && <FocusAlertControls alerts={alerts} />}
    </div>
  );
}
