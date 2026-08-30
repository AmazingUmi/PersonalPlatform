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

function formatWhen(iso: string): string {
  return new Date(iso).toLocaleString(undefined, { dateStyle: "short", timeStyle: "short" });
}

/** "2026-08-30" -> "08-30" (kept lexical to avoid timezone drift). */
function dayLabel(date: string): string {
  return date.slice(5, 10);
}

function FocusStatsChart({ days }: { days: FocusStats["days"] }) {
  // All-zero chart has no story to tell — show the empty copy instead.
  if (days.every((day) => day.focusedSeconds === 0)) {
    return <p className="focus-stats__empty">No records yet</p>;
  }
  const max = Math.max(1, ...days.map((day) => day.focusedSeconds));
  return (
    <div className="focus-stats" role="img" aria-label="Focused time over the last 7 days">
      {days.map((day) => (
        <div key={day.date} className="focus-stats__col">
          <span className="focus-stats__value">{secondsToHumanLabel(day.focusedSeconds)}</span>
          <div className="focus-stats__bar">
            <div
              className="focus-stats__bar-fill"
              style={{ height: `${Math.round((day.focusedSeconds / max) * 100)}%` }}
            />
          </div>
          <span className="focus-stats__label">{dayLabel(day.date)}</span>
        </div>
      ))}
    </div>
  );
}

/** History zone (APP-1 F07): 7-day bar chart + paginated session log. */
export function FocusHistory() {
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
    <PixelWindow title="History" icon="file" className="focus-window">
      <div className="focus-history">
        <section className="focus-history__chart">
          <h3 className="section-title">Last 7 days</h3>
          {stats.loading ? (
            <LoadingState label="Loading stats…" />
          ) : stats.error ? (
            <StatusMessage tone="error">
              <p>{stats.error}</p>
              <PixelButton size="sm" variant="secondary" onClick={stats.reload}>
                Retry
              </PixelButton>
            </StatusMessage>
          ) : (
            <FocusStatsChart days={stats.data?.days ?? []} />
          )}
        </section>

        <section className="focus-history__list">
          <h3 className="section-title">Sessions</h3>
          {listLoading ? (
            <LoadingState label="Loading sessions…" />
          ) : listError ? (
            <StatusMessage tone="error">
              <p>{listError}</p>
              <PixelButton size="sm" variant="secondary" onClick={sessions.reload}>
                Retry
              </PixelButton>
            </StatusMessage>
          ) : items.length === 0 ? (
            <EmptyState
              icon="tasks"
              title="No sessions yet"
              description="Start the timer to record your first focus session."
            />
          ) : (
            <>
              <ul className="focus-history__rows">
                {items.map((item) => (
                  <li key={item.id} className="focus-history__row">
                    <PixelBadge tone={item.kind === "focus" ? "info" : "success"}>
                      {kindLabel(item.kind)}
                    </PixelBadge>
                    <PixelBadge tone={item.status === "completed" ? "success" : "neutral"}>
                      {item.status === "completed" ? "Completed" : "Cancelled"}
                    </PixelBadge>
                    <span className="focus-history__when">
                      {formatWhen(item.startedAt)} – {formatWhen(item.endedAt)}
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
                    Load more
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
