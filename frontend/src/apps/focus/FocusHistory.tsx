import { HelpPopover } from "../../shared/ui/HelpPopover";
import { useI18n } from "../../shared/i18n";
import { useEffect, useState } from "react";
import { EmptyState } from "../../shared/ui/EmptyState";
import { LoadingState } from "../../shared/ui/LoadingState";
import { PixelBadge } from "../../shared/ui/PixelBadge";
import { PixelButton } from "../../shared/ui/PixelButton";
import { PixelWindow } from "../../shared/ui/PixelWindow";
import { StatusMessage } from "../../shared/ui/StatusMessage";
import { useAsync } from "../../shared/useAsync";
import {
  fetchFocusSessions,
  fetchFocusStats,
  formatDuration,
  kindLabel,
  type FocusHistoryItem,
  type FocusStats,
} from "./api";
import { secondsToHumanLabel } from "./FocusToday";

const STATS_DAYS = 7;
const PAGE_SIZE = 10;

function formatWhen(iso: string, locale = "en-US"): string {
  return new Date(iso).toLocaleString(locale, { dateStyle: "short", timeStyle: "short" });
}

/** "2026-08-30" -> "08-30" (kept lexical to avoid timezone drift). */
function dayLabel(date: string, language = "en"): string {
  return language === "zh" ? `${Number(date.slice(5, 7))}月${Number(date.slice(8, 10))}日` : date.slice(5, 10);
}

function FocusStatsChart({ days }: { days: FocusStats["days"] }) {
  const { t, language } = useI18n();
  // All-zero chart has no story to tell — show the empty copy instead.
  if (days.every((day) => day.focusedSeconds === 0)) {
    return <p className="focus-stats__empty">{t("No records yet", "暂无记录")}</p>;
  }
  const max = Math.max(1, ...days.map((day) => day.focusedSeconds));
  return (
    <div className="focus-stats" role="img" aria-label={t("Focused time over the last 7 days", "最近7天的专注时长")}>
      {days.map((day) => (
        <div key={day.date} className="focus-stats__col">
          <span className="focus-stats__value">{secondsToHumanLabel(day.focusedSeconds, language)}</span>
          <div className="focus-stats__bar">
            <div
              className="focus-stats__bar-fill"
              style={{ height: `${Math.round((day.focusedSeconds / max) * 100)}%` }}
            />
          </div>
          <span className="focus-stats__label">{dayLabel(day.date, language)}</span>
        </div>
      ))}
    </div>
  );
}

/** History zone (APP-1 F07): 7-day bar chart + paginated session log. */
export function FocusHistory() {
  const { t, language, locale } = useI18n();
  const [offset, setOffset] = useState(0);
  const [items, setItems] = useState<FocusHistoryItem[]>([]);

  const stats = useAsync(() => fetchFocusStats(STATS_DAYS));
  const sessions = useAsync(() => fetchFocusSessions({ limit: PAGE_SIZE, offset }), [offset]);

  // useAsync replaces its data per page; accumulate pages locally and dedupe
  // by id so a shifting server list can never double-render a row.
  useEffect(() => {
    const data = sessions.data;
    if (!data) return;
    setItems((prev) => {
      if (offset === 0) return data.items;
      const seen = new Set(prev.map((item) => item.id));
      return [...prev, ...data.items.filter((item) => !seen.has(item.id))];
    });
  }, [sessions.data, offset]);

  const total = sessions.data?.total ?? 0;
  const hasMore = items.length < total;
  const listLoading = sessions.loading && items.length === 0;
  const listError = sessions.error && items.length === 0 ? sessions.error : null;

  return (
    <PixelWindow title={t("History", "历史")} icon="file" className="focus-window">
      <div className="focus-history">
        <section className="focus-history__chart">
          <h3 className="section-title">{t("Last 7 days", "最近7天")}</h3>
          {stats.loading ? (
            <LoadingState label={t("Loading stats…", "正在加载统计…")} />
          ) : stats.error ? (
            <StatusMessage tone="error">
              <p>{stats.error}</p>
              <PixelButton size="sm" variant="secondary" onClick={stats.reload}>
                {t("Retry", "重试")}
              </PixelButton>
            </StatusMessage>
          ) : (
            <FocusStatsChart days={stats.data?.days ?? []} />
          )}
        </section>

        <section className="focus-history__list">
          <h3 className="section-title">{t("Sessions", "记录数")}</h3>
          {listLoading ? (
            <LoadingState label={t("Loading sessions…", "正在加载记录…")} />
          ) : listError ? (
            <StatusMessage tone="error">
              <p>{listError}</p>
              <PixelButton size="sm" variant="secondary" onClick={sessions.reload}>
                {t("Retry", "重试")}
              </PixelButton>
            </StatusMessage>
          ) : items.length === 0 ? (
            <EmptyState
              icon="tasks"
              title={t("No sessions yet", "暂无专注记录")}
              description={<HelpPopover label={t("Focus history", "专注历史")}>{t("Start the timer to record your first focus session.", "启动计时器，记录第一次专注。")}</HelpPopover>}
            />
          ) : (
            <>
              <ul className="focus-history__rows">
                {items.map((item) => (
                  <li key={item.id} className="focus-history__row">
                    <PixelBadge tone={item.kind === "focus" ? "info" : "success"}>
                      {kindLabel(item.kind, language)}
                    </PixelBadge>
                    <PixelBadge tone={item.status === "completed" ? "success" : "neutral"}>
                      {item.status === "completed" ? t("Completed", "已完成") : t("Cancelled", "已取消")}
                    </PixelBadge>
                    <span className="focus-history__when">
                      {formatWhen(item.startedAt, locale)} – {formatWhen(item.endedAt, locale)}
                    </span>
                    <span className="focus-history__durations">
                      {formatDuration(item.plannedDurationSeconds)} →{" "}
                      {item.actualDurationSeconds === null
                        ? "—"
                        : formatDuration(item.actualDurationSeconds)}
                    </span>
                  </li>
                ))}
              </ul>
              {hasMore ? (
                <div className="focus-history__more">
                  <PixelButton
                    size="sm"
                    variant="secondary"
                    disabled={sessions.loading}
                    onClick={() => setOffset(items.length)}
                  >
                    {t("Load more", "加载更多")}
                  </PixelButton>
                </div>
              ) : null}
            </>
          )}
        </section>
      </div>
    </PixelWindow>
  );
}
