import { HelpPopover } from "../../shared/ui/HelpPopover";
import { useI18n } from "../../shared/i18n";
import { useEffect, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { useAppDisplayName } from "../../shared/PresentationContext";
import { useDebouncedValue } from "../../shared/useDebouncedValue";
import { EmptyState } from "../../shared/ui/EmptyState";
import { LoadingState } from "../../shared/ui/LoadingState";
import { PixelBadge } from "../../shared/ui/PixelBadge";
import { PixelButton } from "../../shared/ui/PixelButton";
import { PixelIcon } from "../../shared/ui/PixelIcon";
import { appIconName } from "../../shared/ui/appIcons";
import { PixelInput } from "../../shared/ui/PixelInput";
import { PixelWindow } from "../../shared/ui/PixelWindow";
import { StatusMessage } from "../../shared/ui/StatusMessage";
import { useAsync } from "../../shared/useAsync";
import { SyncPendingNotice, useSyncModelRefresh } from "../../shared/sync-guard-client";
import {
  MOODS,
  NOTE_SORT_OPTIONS,
  listNotes,
  listTags,
  moodMeta,
  type Mood,
  type NoteView,
} from "./api";

/** Filter keys that count towards the collapsed Filters-button badge. */
const NOTES_FILTER_KEYS = ["q", "tags", "mood", "pinned", "occurredFrom", "occurredTo"];

const PREVIEW_LIMIT = 200;
const TITLE_LIMIT = 120;

function countActiveFilters(params: URLSearchParams, keys: string[]): number {
  return keys.reduce((count, key) => (params.get(key) ? count + 1 : count), 0);
}

/** `tags` URL param: comma-separated tag ids (multi-select set). */
function parseTagIds(raw: string | null): string[] {
  if (!raw) return [];
  return raw
    .split(",")
    .map((id) => id.trim())
    .filter((id) => id !== "");
}

/** occurredAt time of day in the browser's local timezone (repo convention). */
function formatTimeOfDay(iso: string, locale = "en-US"): string {
  return new Date(iso).toLocaleTimeString(locale, { hour: "2-digit", minute: "2-digit" });
}

/** First non-empty line of the content — the title fallback. */
function firstLine(content: string): string {
  const line = content
    .split("\n")
    .map((l) => l.trim())
    .find((l) => l.length > 0);
  return line ?? "";
}

function truncate(text: string, limit: number): string {
  return text.length > limit ? `${text.slice(0, limit).trimEnd()}…` : text;
}

/** Card preview: single line, ~200 chars (full text lives in the editor). */
function previewText(content: string): string {
  return truncate(content.replace(/\s+/g, " ").trim(), PREVIEW_LIMIT);
}

function displayTitle(note: NoteView): string {
  const title = note.title?.trim() ?? "";
  return title !== "" ? truncate(title, TITLE_LIMIT) : truncate(firstLine(note.content), TITLE_LIMIT);
}

interface DayGroup {
  dayKey: string;
  notes: NoteView[];
}

/** Group by consecutive dayKey runs (worklist §3.3: "按 dayKey 变化分组"). */
function groupByDay(items: NoteView[]): DayGroup[] {
  const groups: DayGroup[] = [];
  for (const note of items) {
    const last = groups[groups.length - 1];
    if (last && last.dayKey === note.dayKey) last.notes.push(note);
    else groups.push({ dayKey: note.dayKey, notes: [note] });
  }
  return groups;
}

/**
 * Group label from the server-computed keys: Today/Yesterday when they match,
 * otherwise the literal day formatted for display only (the frontend never
 * derives "today" itself — worklist §2.1).
 */
function dayLabel(dayKey: string, todayKey: string, yesterdayKey: string, locale = "en-US"): string {
  if (dayKey === todayKey) return locale === "zh-CN" ? "今天" : "Today";
  if (dayKey === yesterdayKey) return locale === "zh-CN" ? "昨天" : "Yesterday";
  return new Date(`${dayKey}T00:00:00`).toLocaleDateString(locale);
}

function NoteCard({ note }: { note: NoteView }) {
  const { t, language, locale } = useI18n();
  const mood = note.mood ? moodMeta(note.mood, language) : null;
  return (
    <li>
      <Link to={`/notes/${note.id}`} className="notes-note" aria-label={t("Open note", "打开笔记")}>
        <span className="notes-note__time">{formatTimeOfDay(note.occurredAt, locale)}</span>
        <span className="notes-note__body">
          <span className="notes-note__title">{displayTitle(note)}</span>
          <span className="notes-note__preview">{previewText(note.content)}</span>
          <span className="notes-note__meta">
            {mood ? <PixelBadge tone={mood.tone}>{mood.label}</PixelBadge> : null}
            {note.pinned ? (
              <PixelBadge tone="warning">{t("Pinned", "置顶")}</PixelBadge>
            ) : null}
            {note.tags.map((tag) => (
              <span key={tag.id} className="px-chip notes-note__tag">
                {tag.name}
              </span>
            ))}
          </span>
        </span>
      </Link>
    </li>
  );
}

export function NotesPage() {
  const { t, language, locale } = useI18n();
  const displayName = useAppDisplayName({ id: "notes", name: "Notes" });
  const [searchParams, setSearchParams] = useSearchParams();
  // Filters collapse into a header button; a deep link with active filters
  // starts expanded (tasks precedent).
  const [filtersOpen, setFiltersOpen] = useState(
    () => countActiveFilters(new URLSearchParams(window.location.search), NOTES_FILTER_KEYS) > 0,
  );

  const setParam = (key: string, value: string) => {
    setSearchParams(
      (params) => {
        const next = new URLSearchParams(params);
        if (value) next.set(key, value);
        else next.delete(key);
        return next;
      },
      { replace: true },
    );
  };

  // Debounced search -> URL (tasks precedent, 250ms).
  const rawSearch = searchParams.get("q") ?? "";
  const [searchInput, setSearchInput] = useState(rawSearch);
  const debouncedSearch = useDebouncedValue(searchInput, 250);
  const appliedSearch = searchParams.get("q") ?? "";
  useEffect(() => {
    if (debouncedSearch !== appliedSearch) setParam("q", debouncedSearch);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [debouncedSearch]);
  useEffect(() => {
    setSearchInput(rawSearch);
  }, [rawSearch]);

  const selectedTagIds = parseTagIds(searchParams.get("tags"));
  const rawMood = searchParams.get("mood") ?? "";
  // Ignore unknown values so a hand-edited deep link never 400s the list.
  const moodFilter: Mood | undefined = MOODS.find((entry) => entry.value === rawMood)?.value;
  const pinnedParam = searchParams.get("pinned");
  const pinnedFilter = pinnedParam === "true";
  const sortBy = searchParams.get("sortBy") ?? "occurredAt";
  const order = searchParams.get("order") === "asc" ? "asc" : "desc";

  const toggleTag = (id: string) => {
    const next = selectedTagIds.includes(id)
      ? selectedTagIds.filter((tagId) => tagId !== id)
      : [...selectedTagIds, id];
    setParam("tags", next.join(","));
  };

  const resetFilters = () => {
    setSearchParams(new URLSearchParams(), { replace: true });
    setSearchInput("");
  };

  const tags = useAsync(() => listTags(), [], { retainOnReload: true });
  const notes = useAsync(
    () =>
      listNotes({
        q: searchParams.get("q") ?? undefined,
        tags: selectedTagIds.length > 0 ? selectedTagIds : undefined,
        mood: moodFilter,
        pinned: pinnedParam === null ? undefined : pinnedFilter,
        occurredFrom: searchParams.get("occurredFrom") ?? undefined,
        occurredTo: searchParams.get("occurredTo") ?? undefined,
        sortBy,
        order,
      }),
    [searchParams.toString()],
    { retainOnReload: true },
  );
  const sync = useSyncModelRefresh(false, () => {
    tags.reload();
    notes.reload();
  });

  const data = notes.data;
  const items = data?.items ?? [];
  const groups = groupByDay(items);
  const hasFilters = NOTES_FILTER_KEYS.some((key) => Boolean(searchParams.get(key)));
  const activeFilterCount = countActiveFilters(searchParams, NOTES_FILTER_KEYS);

  return (
    <div className="page" data-app="notes">
      <SyncPendingNotice pending={sync.pending} onReload={sync.reload} />
      <header className="page-header">
        <div className="px-inline-help">
          <h1 className="page-header__title">
            <PixelIcon name={appIconName("notes")} size={20} className="page-header__app-icon" aria-hidden="true" /> {displayName}
          </h1>
          <HelpPopover label={t("About Notes", "关于笔记")}>{t("Capture first, organize later", "先记录，再整理")}</HelpPopover>
        </div>
        <div className="page-header__actions">
          <PixelButton
            size="sm"
            variant="secondary"
            aria-expanded={filtersOpen}
            onClick={() => setFiltersOpen((open) => !open)}
          >
            <PixelIcon name="search" /> {t("Filters", "筛选")}
            {activeFilterCount > 0 ? <PixelBadge tone="warning">{activeFilterCount}</PixelBadge> : null}
          </PixelButton>
          <Link to="/notes/new" className="px-button px-button--primary px-button--sm">
            <PixelIcon name="plus" /> {t("New Note", "新笔记")}
          </Link>
        </div>
      </header>

      {filtersOpen ? (
        <PixelWindow
          title={t("Filters", "筛选")}
          icon="search"
          className="assets-filters"
          actions={
            <PixelButton
              variant="ghost"
              size="sm"
              onClick={resetFilters}
              disabled={activeFilterCount === 0}
            >
              {t("Reset", "重置")}
            </PixelButton>
          }
        >
          <div className="assets-filters__row">
            <div className="assets-search">
              <PixelIcon name="search" />
              <PixelInput
                placeholder={t("Search notes…", "搜索笔记…")}
                value={searchInput}
                onChange={(e) => setSearchInput(e.target.value)}
                aria-label={t("Search notes", "搜索笔记")}
              />
            </div>
            <select
              className="px-select"
              value={rawMood}
              onChange={(e) => setParam("mood", e.target.value)}
              aria-label={t("Filter by mood", "按心情筛选")}
            >
              <option value="">{t("Any mood", "所有心情")}</option>
              {MOODS.map((mood) => (
                <option key={mood.value} value={mood.value}>
                  {moodMeta(mood.value, language).label}
                </option>
              ))}
            </select>
            <label className="notes-check">
              <input
                type="checkbox"
                className="px-checkbox"
                checked={pinnedFilter}
                onChange={(e) => setParam("pinned", e.target.checked ? "true" : "")}
                aria-label={t("Pinned only", "仅置顶")}
              />
              {t("Pinned only", "仅置顶")}
            </label>
          </div>
          <div className="assets-filters__row">
            <label className="assets-filters__date">
              <span>{t("From", "从")}</span>
              <PixelInput
                type="date"
                value={searchParams.get("occurredFrom")?.slice(0, 10) ?? ""}
                onChange={(e) => setParam("occurredFrom", e.target.value)}
                aria-label={t("Occurred from", "开始日期")}
              />
            </label>
            <label className="assets-filters__date">
              <span>{t("to", "至")}</span>
              <PixelInput
                type="date"
                value={searchParams.get("occurredTo")?.slice(0, 10) ?? ""}
                onChange={(e) => setParam("occurredTo", e.target.value)}
                aria-label={t("Occurred to", "结束日期")}
              />
            </label>
            <select
              className="px-select"
              value={sortBy}
              onChange={(e) => setParam("sortBy", e.target.value)}
              aria-label={t("Sort by", "排序方式")}
            >
              {NOTE_SORT_OPTIONS.map((option) => (
                <option key={option.value} value={option.value}>
                  {t("Sort:", "排序：")} {t(option.label, { occurredAt: "记录时间", createdAt: "创建时间", updatedAt: "修改时间" }[option.value])}
                </option>
              ))}
            </select>
            <PixelButton
              size="sm"
              variant="secondary"
              onClick={() => setParam("order", order === "asc" ? "desc" : "asc")}
              aria-label={t(`Sort order: ${order}. Click to switch.`, `排序：${order === "asc" ? "升序" : "降序"}。点击切换。`)}
            >
              <PixelIcon name={order === "asc" ? "up" : "down"} />
              {order === "asc" ? t("Asc", "升序") : t("Desc", "降序")}
            </PixelButton>
            <span className="assets-filters__spacer" />
            <PixelButton size="sm" variant="secondary" onClick={() => setFiltersOpen(false)}>
              {t("Close", "关闭")}
            </PixelButton>
          </div>
          <div className="notes-filters__tags">
            <span className="notes-filters__tags-label">{t("Tags", "标签")}</span>
            {tags.loading ? (
              <span className="muted">{t("Loading tags…", "正在加载标签…")}</span>
            ) : tags.error ? (
              <span className="muted">{t("Tags unavailable", "标签不可用")}</span>
            ) : tags.data && tags.data.items.length > 0 ? (
              tags.data.items.map((tag) => (
                <button
                  key={tag.id}
                  type="button"
                  className="px-chip"
                  aria-pressed={selectedTagIds.includes(tag.id)}
                  aria-label={t(`Filter by tag ${tag.name}`, `按标签 ${tag.name} 筛选`)}
                  onClick={() => toggleTag(tag.id)}
                >
                  {tag.name}
                </button>
              ))
            ) : (
              <span className="muted">{t("No tags yet", "暂无标签")}</span>
            )}
          </div>
        </PixelWindow>
      ) : null}

      {notes.loading ? (
        <LoadingState label={t("Loading notes…", "正在加载笔记…")} />
      ) : notes.error ? (
        <StatusMessage tone="error">
          <p>{notes.error}</p>
          <PixelButton size="sm" variant="secondary" onClick={notes.reload}>
            {t("Retry", "重试")}
          </PixelButton>
        </StatusMessage>
      ) : items.length === 0 && !hasFilters ? (
        <EmptyState
          icon="file"
          title={t("No notes yet", "暂无笔记")}
          help={<HelpPopover label={t("Notes", "笔记")}>{t("Capture your first thought — you can organize it later.", "记录第一个想法，稍后再整理。")}</HelpPopover>}
          action={
            <Link to="/notes/new" className="px-button px-button--primary px-button--sm">
              <PixelIcon name="plus" /> {t("New Note", "新笔记")}
            </Link>
          }
        />
      ) : items.length === 0 ? (
        <EmptyState icon="search" title={t("No matching notes", "没有匹配的笔记")} help={<HelpPopover label={t("Notes", "笔记")}>{t("Switch the filters to see other notes.", "调整筛选条件以查看其他笔记。")}</HelpPopover>} />
      ) : (
        <PixelWindow title={t("Timeline", "时间线")} icon="file" className="notes-window">
          {data && data.total > data.items.length ? (
            <p className="notes-limit">{t("Showing first", "显示前")} {data.items.length} {t("of", "/")} {data.total} {t("— refine filters", "— 可进一步筛选")}</p>
          ) : null}
          {groups.map((group, index) => {
            const label = dayLabel(group.dayKey, data?.todayKey ?? "", data?.yesterdayKey ?? "", locale);
            return (
            <section key={`${group.dayKey}-${index}`} className="notes-day" aria-label={label}>
              <h3 className="notes-day__label">{label}</h3>
              <ul className="notes-day__list">
                {group.notes.map((note) => (
                  <NoteCard key={note.id} note={note} />
                ))}
              </ul>
            </section>
            );
          })}
        </PixelWindow>
      )}
    </div>
  );
}
