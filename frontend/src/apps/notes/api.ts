import { api } from "../../shared/api";
import type { BadgeTone } from "../../shared/ui/PixelBadge";

/** The five mood values; mirrors the notes.mood CHECK constraint (worklist §1). */
export const MOOD_VALUES = ["great", "good", "neutral", "low", "bad"] as const;

export type Mood = (typeof MOOD_VALUES)[number];

/** Mood metadata for UI: display label + legal PixelBadge tone (worklist §3.7). */
export const MOODS: { value: Mood; label: string; tone: BadgeTone }[] = [
  { value: "great", label: "Great", tone: "success" },
  { value: "good", label: "Good", tone: "info" },
  { value: "neutral", label: "Neutral", tone: "neutral" },
  { value: "low", label: "Low", tone: "warning" },
  { value: "bad", label: "Bad", tone: "danger" },
];

export function moodMeta(mood: Mood): { value: Mood; label: string; tone: BadgeTone } {
  return MOODS.find((entry) => entry.value === mood) ?? MOODS[2]!;
}

export interface NoteTagView {
  id: string;
  name: string;
}

/** camelCase view boundary — matches backend/src/apps/notes/index.ts NoteView. */
export interface NoteView {
  id: string;
  title: string | null;
  content: string;
  mood: Mood | null;
  occurredAt: string;
  pinned: boolean;
  createdAt: string;
  updatedAt: string;
  tags: NoteTagView[];
  dayKey: string;
}

/** List response; day keys are server-computed so the frontend never does
 * timezone math (worklist §2.1). */
export interface NoteListResponse {
  items: NoteView[];
  total: number;
  todayKey: string;
  yesterdayKey: string;
}

export interface TagView {
  id: string;
  name: string;
  createdAt: string;
}

/** Sortable columns allowed by GET /notes (backend allowlist, worklist §2.4). */
export const NOTE_SORT_OPTIONS = [
  { value: "occurredAt", label: "Occurred" },
  { value: "createdAt", label: "Created" },
  { value: "updatedAt", label: "Modified" },
] as const;

export interface NoteListParams {
  q?: string;
  /** Tag ids; multiple ids are AND-combined server-side. */
  tags?: string[];
  mood?: Mood;
  pinned?: boolean;
  /** "YYYY-MM-DD" (platform-local day keys). */
  occurredFrom?: string;
  occurredTo?: string;
  sortBy?: string;
  order?: "asc" | "desc";
}

function notesQuery(params: NoteListParams): string {
  const query = new URLSearchParams();
  if (params.q) query.set("q", params.q);
  if (params.tags && params.tags.length > 0) query.set("tags", params.tags.join(","));
  if (params.mood) query.set("mood", params.mood);
  if (params.pinned !== undefined) query.set("pinned", String(params.pinned));
  if (params.occurredFrom) query.set("occurredFrom", params.occurredFrom);
  if (params.occurredTo) query.set("occurredTo", params.occurredTo);
  if (params.sortBy) query.set("sortBy", params.sortBy);
  if (params.order) query.set("order", params.order);
  const text = query.toString();
  return text ? `?${text}` : "";
}

export function listNotes(params: NoteListParams = {}): Promise<NoteListResponse> {
  return api<NoteListResponse>(`/api/apps/notes/notes${notesQuery(params)}`);
}

export function getNote(id: string): Promise<NoteView> {
  return api<NoteView>(`/api/apps/notes/notes/${id}`);
}

export interface NoteInput {
  content: string;
  title?: string | null;
  mood?: Mood | null;
  /** ISO instant; null/absent = capture time (platform clock). */
  occurredAt?: string | null;
  pinned?: boolean;
  tagIds?: string[];
}

export function createNote(input: NoteInput): Promise<NoteView> {
  return api<NoteView>("/api/apps/notes/notes", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(input),
  });
}

/**
 * Partial update with three-state semantics: absent = keep, explicit null =
 * clear (title/mood) / re-stamp now (occurredAt), value = update. `tagIds` is
 * an all-or-nothing set replacement — never send `tagIds: null` (400).
 */
export type NotePatch = Partial<Omit<NoteInput, "tagIds">> & { tagIds?: string[] };

export function updateNote(id: string, patch: NotePatch): Promise<NoteView> {
  return api<NoteView>(`/api/apps/notes/notes/${id}`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(patch),
  });
}

export function deleteNote(id: string): Promise<void> {
  return api(`/api/apps/notes/notes/${id}`, { method: "DELETE" });
}

export function listTags(): Promise<{ items: TagView[] }> {
  return api<{ items: TagView[] }>("/api/apps/notes/tags");
}

/** Get-or-create upsert (worklist §2.3): 201 when created, 200 when existing. */
export function createTag(name: string): Promise<TagView> {
  return api<TagView>("/api/apps/notes/tags", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name }),
  });
}
