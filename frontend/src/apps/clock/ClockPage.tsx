import { HelpPopover } from "../../shared/ui/HelpPopover";
import { useI18n } from "../../shared/i18n";
import { useState } from "react";
import { useAppDisplayName } from "../../shared/PresentationContext";
import { useAsync } from "../../shared/useAsync";
import { LoadingState } from "../../shared/ui/LoadingState";
import { PixelWindow } from "../../shared/ui/PixelWindow";
import { PixelIcon } from "../../shared/ui/PixelIcon";
import { appIconName } from "../../shared/ui/appIcons";
import { StatusMessage } from "../../shared/ui/StatusMessage";
import { AlarmSection } from "./AlarmSection";
import { ClockFace } from "./ClockWidget";
import { TaskStatusSection } from "./TaskStatusSection";
import { WorldClockSection } from "./WorldClockSection";
import { fetchTasksPublicStatus } from "./tasksPublic";
import { useClockNow } from "./useClockNow";
import type { ClockSettings } from "./useClockSettings";
import { useClockSettings } from "./useClockSettings";

/**
 * Clock app page: a bigger Main Clock plus the Task Status, Alarm and World
 * Clock zones. The faces and controls read/write the same settings row as the
 * dashboard card, so display mode / 12-24h / seconds are shared state.
 */
export function ClockPage() {
  const { t } = useI18n();
  const displayName = useAppDisplayName({ id: "clock", name: "Clock" });
  const [saveFailed, setSaveFailed] = useState(false);
  const { settings, loading, error, reload, save } = useClockSettings();
  const minuteNow = useClockNow(false);
  // One shared public-status fetch: it feeds both the face focus state and
  // the Task Status zone, and re-runs each minute so next→current transitions
  // happen without user action.
  const status = useAsync(() => fetchTasksPublicStatus(), [minuteNow.getMinutes()]);
  const current = status.data?.current ?? null;
  const focus = current ? { title: current.title, startedAt: current.startAt } : null;
  const faceNow = useClockNow(settings.showSeconds || focus !== null);

  if (loading) {
    return (
      <div className="page" data-app="clock">
        <LoadingState label={t("Loading clock…", "正在加载时钟…")} />
      </div>
    );
  }

  const patch = (partial: Partial<ClockSettings>) => {
    void save({ ...settings, ...partial }).then((ok) => setSaveFailed(!ok));
  };

  return (
    <div className="page" data-app="clock">
      <header className="page-header">
        <div className="px-inline-help">
          <h1 className="page-header__title">
            <PixelIcon name={appIconName("clock")} size={20} className="page-header__app-icon" aria-hidden="true" /> {displayName}
          </h1>
          <HelpPopover label={t("About Clock", "关于时钟")}>{t("Clock faces, alarms, world clocks and task status", "时钟、闹钟、世界时钟和任务状态")}</HelpPopover>
        </div>
      </header>

      <div className="clock-page__grid">
        <PixelWindow title={t("Main Clock", "主时钟")} icon="clock" className="clock-page__main">
          {error ? (
            <StatusMessage tone="warning">
              <p>{t("Settings could not be loaded — showing defaults.", "无法加载设置，正在显示默认值。")} {error}</p>
            </StatusMessage>
          ) : null}
          {saveFailed ? (
            <StatusMessage tone="warning">
              <p>{t("Settings could not be saved — check the connection and try again.", "无法保存设置，请检查连接后重试。")}</p>
            </StatusMessage>
          ) : null}
          <div className="clock-page__face">
            <ClockFace now={faceNow} settings={settings} variant="page" focus={focus} />
          </div>
          <div className="clock-controls">
            <div className="px-seg" role="group" aria-label={t("Display mode", "显示方式")}>
              <button
                type="button"
                className="px-seg__btn"
                aria-pressed={settings.displayMode === "digital"}
                onClick={() => patch({ displayMode: "digital" })}
              >
                {t("DIGITAL", "数字")}
              </button>
              <button
                type="button"
                className="px-seg__btn"
                aria-pressed={settings.displayMode === "analog"}
                onClick={() => patch({ displayMode: "analog" })}
              >
                {t("ANALOG", "指针")}
              </button>
            </div>
            {/* The analog face has no numerals format — 12/24H only applies
             * while the digital face is active (the saved value is kept and
             * reused when switching back). */}
            {settings.displayMode === "digital" ? (
              <div className="px-seg" role="group" aria-label={t("Hour format", "小时制")}>
                <button
                  type="button"
                  className="px-seg__btn"
                  aria-pressed={settings.hourFormat === 24}
                  onClick={() => patch({ hourFormat: 24 })}
                >
                  {t("24H", "24小时")}
                </button>
                <button
                  type="button"
                  className="px-seg__btn"
                  aria-pressed={settings.hourFormat === 12}
                  onClick={() => patch({ hourFormat: 12 })}
                >
                  {t("12H", "12小时")}
                </button>
              </div>
            ) : null}
            <label className="clock-controls__check">
              <input
                type="checkbox"
                className="px-checkbox"
                checked={settings.showSeconds}
                onChange={(event) => patch({ showSeconds: event.target.checked })}
              />
              {t("Seconds", "秒数")}
            </label>
            <label className="clock-controls__check">
              <input
                type="checkbox"
                className="px-checkbox"
                checked={settings.showDate}
                onChange={(event) => patch({ showDate: event.target.checked })}
              />
              {t("Date", "日期")}
            </label>
          </div>
        </PixelWindow>

        <PixelWindow title={t("Task Status", "任务状态")} icon="tasks" className="clock-page__tasks">
          <TaskStatusSection now={minuteNow} status={status} />
        </PixelWindow>

        <PixelWindow title={t("Alarms", "闹钟")} icon="clock" className="clock-page__alarms">
          <AlarmSection />
        </PixelWindow>

        <PixelWindow title={t("World Clock", "世界时钟")} icon="clock" className="clock-page__world">
          <WorldClockSection now={minuteNow} />
        </PixelWindow>
      </div>
    </div>
  );
}
