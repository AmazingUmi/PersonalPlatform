import { useMemo, useState } from "react";
import { api } from "../../shared/api";
import { useAsync } from "../../shared/useAsync";
import { useMutation } from "../../shared/useMutation";
import { EmptyState } from "../../shared/ui/EmptyState";
import { LoadingState } from "../../shared/ui/LoadingState";
import { PixelButton } from "../../shared/ui/PixelButton";
import { PixelInput } from "../../shared/ui/PixelInput";
import { StatusMessage } from "../../shared/ui/StatusMessage";
import { formatOffsetDiff, formatZoneTime, zoneDayDiff, zoneOffsetMinutes } from "./timeMath";

export interface WorldClockView {
  id: string;
  city: string;
  timezone: string;
  sortOrder: number;
  createdAt: string;
  updatedAt: string;
}

const WORLD_CLOCKS_URL = "/api/apps/clock/world-clocks";

/** Common suggestions for the datalist; the full IANA set is used when available. */
const COMMON_ZONES = [
  "Asia/Shanghai",
  "Asia/Tokyo",
  "Asia/Singapore",
  "Asia/Dubai",
  "Europe/London",
  "Europe/Paris",
  "Europe/Berlin",
  "America/New_York",
  "America/Chicago",
  "America/Los_Angeles",
  "Australia/Sydney",
  "Pacific/Auckland",
];

function timezoneOptions(): string[] {
  try {
    const supported = Intl.supportedValuesOf?.("timeZone");
    return supported && supported.length > 0 ? [...supported] : COMMON_ZONES;
  } catch {
    return COMMON_ZONES;
  }
}

/**
 * World clock list. Every entry stores an IANA zone name (never an offset),
 * so DST transitions, cross-day and half-hour zones are all resolved by Intl
 * at display time. The list re-renders from the parent's minute tick.
 */
export function WorldClockSection({ now }: { now: Date }) {
  const clocks = useAsync(() => api<{ items: WorldClockView[] }>(WORLD_CLOCKS_URL));
  const [city, setCity] = useState("");
  const [timezone, setTimezone] = useState("");
  const datalistId = "clock-timezone-options";

  const add = useMutation(async () => {
    await api(WORLD_CLOCKS_URL, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ city: city.trim(), timezone: timezone.trim() }),
    });
  });

  const items = clocks.data?.items ?? [];
  const homeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;

  const removeAt = async (entry: WorldClockView) => {
    try {
      await api(`${WORLD_CLOCKS_URL}/${entry.id}`, { method: "DELETE" });
    } finally {
      clocks.reload();
    }
  };

  const move = async (index: number, delta: -1 | 1) => {
    const target = index + delta;
    if (target < 0 || target >= items.length) return;
    const ids = items.map((entry) => entry.id);
    [ids[index], ids[target]] = [ids[target]!, ids[index]!];
    try {
      await api(`${WORLD_CLOCKS_URL}/order`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ ids }),
      });
    } finally {
      clocks.reload();
    }
  };

  const canAdd = city.trim().length > 0 && timezone.trim().length > 0;
  const zoneOptions = useMemo(() => timezoneOptions(), []);

  return (
    <div className="clock-world">
      {clocks.loading ? <LoadingState label="Loading world clocks…" /> : null}
      {clocks.error ? (
        <div className="widget-fallback">
          <StatusMessage tone="error">
            <p>{clocks.error}</p>
          </StatusMessage>
          <PixelButton size="sm" variant="secondary" onClick={clocks.reload}>
            Retry
          </PixelButton>
        </div>
      ) : null}

      {!clocks.loading && !clocks.error && items.length === 0 ? (
        <EmptyState
          icon="clock"
          title="No world clocks"
          description={`Add a city to compare its local time with ${homeZone}.`}
        />
      ) : null}

      {items.length > 0 ? (
        <ul className="clock-world__list">
          {items.map((entry, index) => {
            const diff = zoneOffsetMinutes(now, entry.timezone) - zoneOffsetMinutes(now, homeZone);
            const dayDiff = zoneDayDiff(now, homeZone, entry.timezone);
            return (
              <li key={entry.id} className="clock-world__row">
                <div className="clock-world__main">
                  <span className="clock-world__city">{entry.city}</span>
                  <span className="clock-world__zone">{entry.timezone}</span>
                </div>
                <div className="clock-world__time">
                  <span className="clock-world__clock">{formatZoneTime(now, entry.timezone)}</span>
                  <span className="clock-world__offset">
                    {dayDiffLabel(dayDiff)}
                    {diff !== 0 ? ` ${formatOffsetDiff(diff)}` : ""}
                  </span>
                </div>
                <div className="clock-world__actions">
                  <PixelButton
                    size="sm"
                    variant="secondary"
                    onClick={() => void move(index, -1)}
                    disabled={index === 0}
                    aria-label={`Move ${entry.city} up`}
                  >
                    ↑
                  </PixelButton>
                  <PixelButton
                    size="sm"
                    variant="secondary"
                    onClick={() => void move(index, 1)}
                    disabled={index === items.length - 1}
                    aria-label={`Move ${entry.city} down`}
                  >
                    ↓
                  </PixelButton>
                  <PixelButton
                    size="sm"
                    variant="danger"
                    onClick={() => void removeAt(entry)}
                    aria-label={`Remove ${entry.city}`}
                  >
                    ✕
                  </PixelButton>
                </div>
              </li>
            );
          })}
        </ul>
      ) : null}

      <form
        className="clock-world__add px-form"
        onSubmit={async (event) => {
          event.preventDefault();
          if (!(await add.mutate())) return;
          setCity("");
          setTimezone("");
          clocks.reload();
        }}
      >
        <datalist id={datalistId}>
          {zoneOptions.map((zone) => (
            <option key={zone} value={zone} />
          ))}
        </datalist>
        <div className="px-form__grid">
          <label className="px-form__row">
            <span className="px-form__label">City</span>
            <PixelInput
              type="text"
              value={city}
              maxLength={60}
              placeholder="Tokyo"
              onChange={(event) => setCity(event.target.value)}
              aria-label="City name"
            />
          </label>
          <label className="px-form__row">
            <span className="px-form__label">Timezone (IANA)</span>
            <PixelInput
              type="text"
              value={timezone}
              maxLength={64}
              placeholder="Asia/Tokyo"
              list={datalistId}
              onChange={(event) => setTimezone(event.target.value)}
              aria-label="IANA timezone"
            />
          </label>
        </div>
        {add.error ? (
          <StatusMessage tone="error">
            <p>{add.error}</p>
          </StatusMessage>
        ) : null}
        <PixelButton type="submit" size="sm" disabled={!canAdd || add.busy}>
          {add.busy ? "Adding…" : "+ Add City"}
        </PixelButton>
      </form>
    </div>
  );
}

function dayDiffLabel(diff: number): string {
  if (diff === 0) return "Today";
  if (diff === 1) return "Tomorrow";
  if (diff === -1) return "Yesterday";
  return `${diff > 0 ? "+" : ""}${diff}d`;
}
