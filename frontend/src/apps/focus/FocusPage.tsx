import { useAppDisplayName } from "../../shared/PresentationContext";
import { LoadingState } from "../../shared/ui/LoadingState";
import { PixelButton } from "../../shared/ui/PixelButton";
import { PixelIcon } from "../../shared/ui/PixelIcon";
import { StatusMessage } from "../../shared/ui/StatusMessage";
import { FocusHistory } from "./FocusHistory";
import { FocusSettings } from "./FocusSettings";
import { FocusTimer } from "./FocusTimer";
import { FocusToday } from "./FocusToday";
import { useFocusState } from "./useFocusState";

/**
 * Focus app main page (APP-1 F07): single-page, four stacked PixelWindow
 * zones — Timer, Today, History, Settings. All server timing flows through
 * one top-level `useFocusState()` and down as props.
 */
export function FocusPage() {
  const displayName = useAppDisplayName({ id: "focus", name: "Focus" });
  const { state, loading, error, busy, remainingSeconds, dispatch, reload } = useFocusState();

  return (
    <div className="page" data-app="focus">
      <header className="page-header">
        <h1 className="page-header__title">{displayName}</h1>
        <p className="page-header__subtitle">Pomodoro timer with daily summary and history</p>
        <div className="page-header__actions">
          <PixelButton size="sm" variant="secondary" onClick={reload}>
            <PixelIcon name="refresh" /> Refresh
          </PixelButton>
        </div>
      </header>

      {loading ? (
        <LoadingState label="Loading focus…" />
      ) : !state ? (
        <StatusMessage tone="error">
          <p>{error ?? "Unable to load focus state."}</p>
          <PixelButton size="sm" variant="secondary" onClick={reload}>
            Retry
          </PixelButton>
        </StatusMessage>
      ) : (
        <>
          <FocusTimer
            state={state}
            remainingSeconds={remainingSeconds}
            busy={busy}
            error={error}
            dispatch={dispatch}
          />
          <FocusToday today={state.today} />
          <FocusHistory />
          <FocusSettings settings={state.settings} onSaved={reload} />
        </>
      )}
    </div>
  );
}
