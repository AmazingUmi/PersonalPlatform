import { useEffect, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { useAppDisplayName } from "../../shared/PresentationContext";
import { useDebouncedValue } from "../../shared/useDebouncedValue";
import { EmptyState } from "../../shared/ui/EmptyState";
import { LoadingState } from "../../shared/ui/LoadingState";
import { PixelBadge } from "../../shared/ui/PixelBadge";
import { PixelButton } from "../../shared/ui/PixelButton";
import { PixelIcon } from "../../shared/ui/PixelIcon";
import { PixelInput } from "../../shared/ui/PixelInput";
import { PixelWindow } from "../../shared/ui/PixelWindow";
import { StatusMessage } from "../../shared/ui/StatusMessage";
import { useAsync } from "../../shared/useAsync";
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
function formatTimeOfDay(iso: string): string {
  return new Date(iso).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
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
function dayLabel(dayKey: string, todayKey: string, yesterdayKey: string): string {
  if (dayKey === todayKey) return "Today";
  if (dayKey === yesterdayKey) return "Yesterday";
  return new Date(`${dayKey}T00:00:00`).toLocaleDateString();
}

function NoteCard({ note }: { note: NoteView }) {
  const mood = note.mood ? moodMeta(note.mood) : null;
  return (
    <li>
      <Link to={`/notes/${note.id}`} className="notes-note" aria-label="Open note">
        <span className="notes-note__time">{formatTimeOfDay(note.occurredAt)}</span>
        <span className="notes-note__body">
          <span className="notes-note__title">{displayTitle(note)}</span>
          <span className="notes-note__preview">{previewText(note.content)}</span>
          <span className="notes-note__meta">
            {mood ? <PixelBadge tone={mood.tone}>{mood.label}</PixelBadge> : null}
            {note.pinned ? (
              <PixelBadge tone="warning">Pinned</PixelBadge>
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

  const tags = useAsync(() => listTags(), []);
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
  );

  const data = notes.data;
  const items = data?.items ?? [];
  const groups = groupByDay(items);
  const hasFilters = NOTES_FILTER_KEYS.some((key) => Boolean(searchParams.get(key)));
  const activeFilterCount = countActiveFilters(searchParams, NOTES_FILTER_KEYS);

  return (
    <div className="page" data-app="notes">
      <header className="page-header">
        <h1 className="page-header__title">{displayName}</h1>
        <p className="page-header__subtitle">Capture first, organize later</p>
        <div className="page-header__actions">
          <PixelButton
            size="sm"
            variant="secondary"
            aria-expanded={filtersOpen}
            onClick={() => setFiltersOpen((open) => !open)}
          >
            <PixelIcon name="search" /> Filters
            {activeFilterCount > 0 ? <PixelBadge tone="warning">{activeFilterCount}</PixelBadge> : null}
          </PixelButton>
          <Link to="/notes/new" className="px-button px-button--primary px-button--sm">
            <PixelIcon name="plus" /> New Note
          </Link>
        </div>
      </header>

      {filtersOpen ? (
        <PixelWindow
          title="Filters"
          icon="search"
          className="assets-filters"
          actions={
            <PixelButton
              variant="ghost"
              size="sm"
              onClick={resetFilters}
              disabled={activeFilterCount === 0}
            >
              Reset
            </PixelButton>
          }
        >
          <div className="assets-filters__row">
            <div className="assets-search">
              <PixelIcon name="search" />
              <PixelInput
                placeholder="Search notes…"
                value={searchInput}
                onChange={(e) => setSearchInput(e.target.value)}
                aria-label="Search notes"
              />
            </div>
            <select
              className="px-select"
              value={rawMood}
              onChange={(e) => setParam("mood", e.target.value)}
              aria-label="Filter by mood"
            >
              <option value="">Any mood</option>
              {MOODS.map((mood) => (
                <option key={mood.value} value={mood.value}>
                  {mood.label}
                </option>
              ))}
            </select>
            <label className="notes-check">
              <input
                type="checkbox"
                className="px-checkbox"
                checked={pinnedFilter}
                onChange={(e) => setParam("pinned", e.target.checked ? "true" : "")}
                aria-label="Pinned only"
              />
              Pinned only
            </label>
          </div>
          <div className="assets-filters__row">
            <label className="assets-filters__date">
              <span>From</span>
              <PixelInput
                type="date"
                value={searchParams.get("occurredFrom")?.slice(0, 10) ?? ""}
                onChange={(e) => setParam("occurredFrom", e.target.value)}
                aria-label="Occurred from"
              />
            </label>
            <label className="assets-filters__date">
              <span>to</span>
              <PixelInput
                type="date"
                value={searchParams.get("occurredTo")?.slice(0, 10) ?? ""}
                onChange={(e) => setParam("occurredTo", e.target.value)}
                aria-label="Occurred to"
              />
            </label>
            <select
              className="px-select"
              value={sortBy}
              onChange={(e) => setParam("sortBy", e.target.value)}
              aria-label="Sort by"
            >
              {NOTE_SORT_OPTIONS.map((option) => (
                <option key={option.value} value={option.value}>
                  Sort: {option.label}
                </option>
              ))}
            </select>
            <PixelButton
              size="sm"
              variant="secondary"
              onClick={() => setParam("order", order === "asc" ? "desc" : "asc")}
              aria-label={`Sort order: ${order}. Click to switch.`}
            >
              <PixelIcon name={order === "asc" ? "up" : "down"} />
              {order === "asc" ? "Asc" : "Desc"}
            </PixelButton>
            <span className="assets-filters__spacer" />
            <PixelButton size="sm" variant="secondary" onClick={() => setFiltersOpen(false)}>
              Close
            </PixelButton>
          </div>
          <div className="notes-filters__tags">
            <span className="notes-filters__tags-label">Tags</span>
            {tags.loading ? (
              <span className="muted">Loading tags…</span>
            ) : tags.error ? (
              <span className="muted">Tags unavailable</span>
            ) : tags.data && tags.data.items.length > 0 ? (
              tags.data.items.map((tag) => (
                <button
                  key={tag.id}
                  type="button"
                  className="px-chip"
                  aria-pressed={selectedTagIds.includes(tag.id)}
                  aria-label={`Filter by tag ${tag.name}`}
                  onClick={() => toggleTag(tag.id)}
                >
                  {tag.name}
                </button>
              ))
            ) : (
              <span className="muted">No tags yet</span>
            )}
          </div>
        </PixelWindow>
      ) : null}

      {notes.loading ? (
        <LoadingState label="Loading notes…" />
      ) : notes.error ? (
        <StatusMessage tone="error">
          <p>{notes.error}</p>
          <PixelButton size="sm" variant="secondary" onClick={notes.reload}>
            Retry
          </PixelButton>
        </StatusMessage>
      ) : items.length === 0 && !hasFilters ? (
        <EmptyState
          icon="file"
          title="No notes yet"
          description="Capture your first thought — you can organize it later."
          action={
            <Link to="/notes/new" className="px-button px-button--primary px-button--sm">
              <PixelIcon name="plus" /> New Note
            </Link>
          }
        />
      ) : items.length === 0 ? (
        <EmptyState icon="search" title="No matching notes" description="Switch the filters to see other notes." />
      ) : (
        <PixelWindow title="Timeline" icon="file" className="notes-window">
          {data && data.total > data.items.length ? (
            <p className="notes-limit">Showing first {data.items.length} of {data.total} — refine filters</p>
          ) : null}
          {groups.map((group, index) => {
            const label = dayLabel(group.dayKey, data?.todayKey ?? "", data?.yesterdayKey ?? "");
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
