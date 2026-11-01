import { HelpPopover } from "../../shared/ui/HelpPopover";
import { useI18n } from "../../shared/i18n";
import { useState } from "react";
import { api } from "../../shared/api";
import { useAsync } from "../../shared/useAsync";
import { useMutation } from "../../shared/useMutation";
import { EmptyState } from "../../shared/ui/EmptyState";
import { LoadingState } from "../../shared/ui/LoadingState";
import { PixelButton } from "../../shared/ui/PixelButton";
import { StatusMessage } from "../../shared/ui/StatusMessage";
import { formatOffsetDiff, formatZoneTime, zoneDayDiff, zoneOffsetMinutes } from "./timeMath";
import { WORLD_CITY_PRESETS, findWorldCityPreset, worldCityValue, worldCityLabel } from "./worldCities";

export interface WorldClockView {
  id: string;
  city: string;
  timezone: string;
  sortOrder: number;
  createdAt: string;
  updatedAt: string;
}

const WORLD_CLOCKS_URL = "/api/apps/clock/world-clocks";

/**
 * World clock list. Every entry stores an IANA zone name (never an offset),
 * so DST transitions, cross-day and half-hour zones are all resolved by Intl
 * at display time. The list re-renders from the parent's minute tick.
 *
 * Adding is preset-driven: city and timezone are bound pairs picked from a
 * dropdown (worldCities.ts), so a mismatched combination can never be saved.
 */
export function WorldClockSection({ now }: { now: Date }) {
  const { t, language } = useI18n();
  const clocks = useAsync(() => api<{ items: WorldClockView[] }>(WORLD_CLOCKS_URL));
  const [presetValue, setPresetValue] = useState("");
  const preset = findWorldCityPreset(presetValue);

  const add = useMutation(async () => {
    if (!preset) return;
    await api(WORLD_CLOCKS_URL, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ city: preset.city, timezone: preset.timezone }),
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
    [ids[index], ids[target]] = [ids[target], ids[index]!];
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

  const alreadyAdded =
    preset !== undefined && items.some((entry) => entry.city === preset.city && entry.timezone === preset.timezone);
  const canAdd = preset !== undefined && !alreadyAdded;

  return (
    <div className="clock-world">
      {clocks.loading ? <LoadingState label={t("Loading world clocks…", "正在加载世界时钟…")} /> : null}
      {clocks.error ? (
        <div className="widget-fallback">
          <StatusMessage tone="error">
            <p>{clocks.error}</p>
          </StatusMessage>
          <PixelButton size="sm" variant="secondary" onClick={clocks.reload}>
            {t("Retry", "重试")}
          </PixelButton>
        </div>
      ) : null}

      {!clocks.loading && !clocks.error && items.length === 0 ? (
        <EmptyState
          icon="clock"
          title={t("No world clocks", "暂无世界时钟")}
          description={<HelpPopover label={t("World clocks", "世界时钟")}>{t(`Add a city to compare its local time with ${homeZone}.`, `添加城市，将当地时间与 ${homeZone} 比较。`)}</HelpPopover>}
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
                  <span className="clock-world__city">{worldCityLabel(entry, language)}</span>
                  <span className="clock-world__zone">{entry.timezone}</span>
                </div>
                <div className="clock-world__time">
                  <span className="clock-world__clock">{formatZoneTime(now, entry.timezone)}</span>
                  <span className="clock-world__offset">
                    {dayDiffLabel(dayDiff, language)}
                    {diff !== 0 ? ` ${formatOffsetDiff(diff, language)}` : ""}
                  </span>
                </div>
                <div className="clock-world__actions">
                  <PixelButton
                    size="sm"
                    variant="secondary"
                    onClick={() => void move(index, -1)}
                    disabled={index === 0}
                    aria-label={t(`Move ${entry.city} up`, `上移 ${worldCityLabel(entry, language)}`)}
                  >
                    ↑
                  </PixelButton>
                  <PixelButton
                    size="sm"
                    variant="secondary"
                    onClick={() => void move(index, 1)}
                    disabled={index === items.length - 1}
                    aria-label={t(`Move ${entry.city} down`, `下移 ${worldCityLabel(entry, language)}`)}
                  >
                    ↓
                  </PixelButton>
                  <PixelButton
                    size="sm"
                    variant="danger"
                    onClick={() => void removeAt(entry)}
                    aria-label={t(`Remove ${entry.city}`, `移除 ${worldCityLabel(entry, language)}`)}
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
          setPresetValue("");
          clocks.reload();
        }}
      >
        <label className="px-form__row">
          <span className="px-form__label">{t("City (timezone bound)", "城市（对应时区）")}</span>
          <select
            className="px-select"
            value={presetValue}
            onChange={(event) => setPresetValue(event.target.value)}
            aria-label={t("City and timezone", "城市与时区")}
          >
            <option value="">{t("Select a city…", "选择城市…")}</option>
            {WORLD_CITY_PRESETS.map((entry) => (
              <option key={worldCityValue(entry)} value={worldCityValue(entry)}>
                {worldCityLabel(entry, language)} · {entry.timezone}
              </option>
            ))}
          </select>
        </label>
        {preset ? <HelpPopover label={t("City timezone", "城市时区")}>{t(`Binds ${preset.city} to ${preset.timezone}.`, `${worldCityLabel(preset, language)} 对应时区 ${preset.timezone}。`)}</HelpPopover> : null}
        {alreadyAdded ? (
          <p className="clock-world__add-hint">{preset ? worldCityLabel(preset, language) : ""} {t("is already on the list.", "已在列表中。")}</p>
        ) : null}
        {add.error ? (
          <StatusMessage tone="error">
            <p>{add.error}</p>
          </StatusMessage>
        ) : null}
        <PixelButton type="submit" size="sm" disabled={!canAdd || add.busy}>
          {add.busy ? t("Adding…", "添加中…") : t("+ Add City", "+ 添加城市")}
        </PixelButton>
      </form>
    </div>
  );
}

function dayDiffLabel(diff: number, language = "en"): string {
  if (diff === 0) return language === "zh" ? "今天" : "Today";
  if (diff === 1) return language === "zh" ? "明天" : "Tomorrow";
  if (diff === -1) return language === "zh" ? "昨天" : "Yesterday";
  return `${diff > 0 ? "+" : ""}${diff}${language === "zh" ? "天" : "d"}`;
}
