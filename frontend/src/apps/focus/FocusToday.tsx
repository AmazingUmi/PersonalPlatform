import { PixelWindow } from "../../shared/ui/PixelWindow";
import type { FocusState } from "./api";

/** Compact duration label: 8100 -> "2h 15m", 300 -> "5m", 45 -> "45s". */
export function secondsToHumanLabel(totalSeconds: number): string {
  const total = Math.max(0, Math.floor(totalSeconds));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;
  if (hours >= 1) return `${hours}h ${minutes}m`;
  if (minutes >= 1) return `${minutes}m`;
  return `${seconds}s`;
}

/** Today zone (APP-1 F07): focused time / rounds / sessions summary. */
export function FocusToday({ today }: { today: FocusState["today"] }) {
  return (
    <PixelWindow title="Today" icon="check" className="focus-window">
      <div className="px-stats">
        <div className="px-stat">
          <span className="px-stat__label">Focused</span>
          <span className="px-stat__value">{secondsToHumanLabel(today.focusedSeconds)}</span>
        </div>
        <div className="px-stat">
          <span className="px-stat__label">Rounds</span>
          <span className="px-stat__value">{today.completedRounds}</span>
        </div>
        <div className="px-stat">
          <span className="px-stat__label">Sessions</span>
          <span className="px-stat__value">{today.sessionsEnded}</span>
        </div>
      </div>
    </PixelWindow>
  );
}
