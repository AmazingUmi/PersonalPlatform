import { PixelButton } from "../../shared/ui/PixelButton";
import { kindLabel, type FocusHistoryItem } from "./api";
import type { useFocusAlerts } from "./useFocusAlerts";

type Alerts = ReturnType<typeof useFocusAlerts>;
export function FocusAlertControls({ alerts }: { alerts: Alerts }) {
  return (
    <div className="focus-alerts">
      <div className="focus-alerts__controls" aria-label="Completion alerts">
        <PixelButton size="sm" variant="secondary" onClick={alerts.sound ? alerts.muteSound : alerts.enableSound}>
          {alerts.sound ? "Mute sound" : "Enable sound"}
        </PixelButton>
        <PixelButton size="sm" variant="secondary" disabled={!alerts.sound} onClick={alerts.testSound}>Test sound</PixelButton>
        <PixelButton size="sm" variant="secondary" onClick={alerts.notifications ? alerts.disableNotifications : alerts.enableNotifications}>
          {alerts.notifications ? "Disable notifications" : "Enable notifications"}
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
  return (
    <div className={compact ? "focus-alerts focus-alerts--compact" : "focus-alerts"}>
      <div className={completion ? "focus-completion" : undefined} role="status" aria-live="polite" aria-atomic="true">
        {completion ? (
          <div>
            <strong>{kindLabel(completion.kind)} complete</strong>
            {!compact && <p>Your session has finished. Start the next session when you are ready.</p>}
            <PixelButton size="sm" variant="secondary" onClick={onDismiss} aria-label="Dismiss completion">
              {compact ? "×" : "Dismiss completion"}
            </PixelButton>
          </div>
        ) : null}
      </div>
      {!compact && <FocusAlertControls alerts={alerts} />}
    </div>
  );
}
