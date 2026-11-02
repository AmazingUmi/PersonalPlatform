import { HelpPopover } from "../../shared/ui/HelpPopover";
import { useI18n } from "../../shared/i18n";
import { FocusCompletion } from "./FocusCompletion";
import { useAppDisplayName } from "../../shared/PresentationContext";
import { LoadingState } from "../../shared/ui/LoadingState";
import { PixelButton } from "../../shared/ui/PixelButton";
import { PixelIcon } from "../../shared/ui/PixelIcon";
import { appIconName } from "../../shared/ui/appIcons";
import { StatusMessage } from "../../shared/ui/StatusMessage";
import { FocusHistory } from "./FocusHistory";
import { FocusSettings } from "./FocusSettings";
import { FocusTimer } from "./FocusTimer";
import { FocusToday } from "./FocusToday";
import { useFocusState } from "./useFocusState";
import { SyncPendingNotice } from "../../shared/sync-guard-client";

/**
 * Focus app main page (APP-1 F07): single-page, four stacked PixelWindow
 * zones — Timer, Today, History, Settings. All server timing flows through
 * one top-level `useFocusState()` and down as props.
 */
export function FocusPage() {
  const { t } = useI18n();
  const displayName = useAppDisplayName({ id: "focus", name: "Focus" });
  const { state, loading, error, busy, remainingSeconds, dispatch, reload, completion, dismissCompletion, alerts, syncPending, acceptServerSync } = useFocusState();

  return (
    <div className="page" data-app="focus">
      <SyncPendingNotice pending={syncPending} onReload={acceptServerSync} />
      <header className="page-header">
        <div className="px-inline-help">
          <h1 className="page-header__title">
            <PixelIcon name={appIconName("focus")} size={20} className="page-header__app-icon" aria-hidden="true" /> {displayName}
          </h1>
          <HelpPopover label={t("About Focus", "关于专注")}>{t("Pomodoro timer with daily summary and history", "番茄计时、每日统计与历史记录")}</HelpPopover>
        </div>
        <div className="page-header__actions">
          <PixelButton size="sm" variant="secondary" onClick={reload}>
            <PixelIcon name="refresh" /> {t("Refresh", "刷新")}
          </PixelButton>
        </div>
      </header>

      {loading ? (
        <LoadingState label={t("Loading focus…", "正在加载专注状态…")} />
      ) : !state ? (
        <StatusMessage tone="error">
          <p>{error ?? t("Unable to load focus state.", "无法加载专注状态。")}</p>
          <PixelButton size="sm" variant="secondary" onClick={reload}>
            {t("Retry", "重试")}
          </PixelButton>
        </StatusMessage>
      ) : (
        <>
          <FocusCompletion completion={completion} onDismiss={dismissCompletion} alerts={alerts} />
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
