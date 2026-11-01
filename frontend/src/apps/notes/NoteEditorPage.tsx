import { HelpPopover } from "../../shared/ui/HelpPopover";
import { useI18n } from "../../shared/i18n";
import { useEffect, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { useAppDisplayName } from "../../shared/PresentationContext";
import { useMutation } from "../../shared/useMutation";
import { ConfirmDialog } from "../../shared/ui/ConfirmDialog";
import { LoadingState } from "../../shared/ui/LoadingState";
import { PixelButton } from "../../shared/ui/PixelButton";
import { PixelIcon } from "../../shared/ui/PixelIcon";
import { PixelInput } from "../../shared/ui/PixelInput";
import { PixelWindow } from "../../shared/ui/PixelWindow";
import { StatusMessage } from "../../shared/ui/StatusMessage";
import { useAsync } from "../../shared/useAsync";
import {
  MOODS,
  moodMeta,
  createNote,
  createTag,
  deleteNote,
  getNote,
  listTags,
  updateNote,
  type Mood,
  type NotePatch,
  type NoteView,
  type TagView,
} from "./api";

/** ISO instant -> value usable by <input type="datetime-local"> in local time. */
function toLocalInputValue(iso: string | null): string {
  if (!iso) return "";
  const date = new Date(iso);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/** datetime-local value -> ISO instant (null when empty). */
function fromLocalInputValue(value: string): string | null {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

/** Same set of ids regardless of order (tagIds are an unordered set server-side). */
function sameIdSet(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  const setB = new Set(b);
  return a.every((id) => setB.has(id));
}

interface NoteFormState {
  title: string;
  /** datetime-local value; "" = no custom time (capture time). */
  occurredAt: string;
  /** "" = none (null at the API boundary). */
  mood: string;
  tagIds: string[];
  content: string;
  pinned: boolean;
}

function emptyFormState(): NoteFormState {
  return { title: "", occurredAt: "", mood: "", tagIds: [], content: "", pinned: false };
}

function formStateFromNote(note: NoteView): NoteFormState {
  return {
    title: note.title ?? "",
    occurredAt: toLocalInputValue(note.occurredAt),
    mood: note.mood ?? "",
    tagIds: note.tags.map((tag) => tag.id),
    content: note.content,
    pinned: note.pinned,
  };
}

/**
 * Full-field note editor, shared by /notes/new and /notes/:id (worklist §3.4).
 * Create sends every field; edit PATCHes only what changed, using the backend's
 * three-state semantics: absent = keep, null = clear (or re-stamp for
 * occurredAt), value = update.
 */
function NoteEditorForm({ note }: { note: NoteView | null }) {
  const { t, language } = useI18n();
  const navigate = useNavigate();
  const isEdit = note !== null;
  const [form, setForm] = useState<NoteFormState>(() =>
    note ? formStateFromNote(note) : emptyFormState(),
  );
  const set = <K extends keyof NoteFormState>(key: K, value: NoteFormState[K]) =>
    setForm((current) => ({ ...current, [key]: value }));

  // Existing tags for the chip toggles; extended locally when a tag is created.
  const tagList = useAsync(() => listTags(), []);
  const [allTags, setAllTags] = useState<TagView[]>([]);
  useEffect(() => {
    if (tagList.data) setAllTags(tagList.data.items);
  }, [tagList.data]);

  const toggleTag = (tagId: string) =>
    setForm((current) => ({
      ...current,
      tagIds: current.tagIds.includes(tagId)
        ? current.tagIds.filter((id) => id !== tagId)
        : [...current.tagIds, tagId],
    }));

  // New tag: Enter posts the get-or-create upsert and selects the result.
  const [newTagName, setNewTagName] = useState("");
  const tagCreate = useMutation(async () => {
    const name = newTagName.trim();
    if (!name) return;
    const tag = await createTag(name);
    setAllTags((current) => (current.some((t) => t.id === tag.id) ? current : [...current, tag]));
    setForm((current) =>
      current.tagIds.includes(tag.id) ? current : { ...current, tagIds: [...current.tagIds, tag.id] },
    );
    setNewTagName("");
  });

  const save = useMutation(async () => {
    const content = form.content.trim();
    if (content === "") return; // frontend guard: never send an empty body
    if (isEdit && note) {
      const patch: NotePatch = {};
      const title = form.title.trim();
      if (title !== (note.title ?? "")) patch.title = title === "" ? null : title;
      if (form.mood !== (note.mood ?? "")) patch.mood = form.mood === "" ? null : (form.mood as Mood);
      // Compare in datetime-local space so minute truncation is not a change.
      // Clearing the field sends null = re-stamp with the platform clock.
      if (form.occurredAt !== toLocalInputValue(note.occurredAt)) {
        patch.occurredAt = fromLocalInputValue(form.occurredAt);
      }
      if (form.content !== note.content) patch.content = form.content;
      if (form.pinned !== note.pinned) patch.pinned = form.pinned;
      if (!sameIdSet(form.tagIds, note.tags.map((tag) => tag.id))) patch.tagIds = form.tagIds;
      await updateNote(note.id, patch);
    } else {
      await createNote({
        content: form.content,
        title: form.title.trim() === "" ? null : form.title.trim(),
        mood: form.mood === "" ? null : (form.mood as Mood),
        occurredAt: fromLocalInputValue(form.occurredAt),
        pinned: form.pinned,
        tagIds: form.tagIds,
      });
    }
  });

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (form.content.trim() === "" || save.busy) return;
    if (await save.mutate()) navigate("/notes");
  };

  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const remove = useMutation(async () => {
    if (note) await deleteNote(note.id);
  });

  const contentBlank = form.content.trim() === "";

  return (
    <>
      <PixelWindow
        title={isEdit ? t("Edit Note", "编辑笔记") : t("New Note", "新笔记")}
        icon="file"
        className="notes-editor"
        headingLevel={2}
      >
        <form className="px-form" onSubmit={submit} aria-label={isEdit ? t("Edit note", "编辑笔记") : t("Create note", "创建笔记")}>
          <label className="px-form__row">
            <span className="px-form__label">{t("Title", "标题")}</span>
            <PixelInput
              value={form.title}
              onChange={(e) => set("title", e.target.value)}
              aria-label={t("Note title", "笔记标题")}
              placeholder={t("Optional", "选填")}
              autoFocus
            />
          </label>
          <div className="px-form__grid">
            <label className="px-form__row">
              <span className="px-form__label">{t("Occurred At", "记录时间")}</span>
              <PixelInput
                type="datetime-local"
                value={form.occurredAt}
                onChange={(e) => set("occurredAt", e.target.value)}
                aria-label={t("Occurred at", "记录时间")}
              />
            </label>
            <label className="px-form__row">
              <span className="px-form__label">{t("Mood", "心情")}</span>
              <select
                className="px-select"
                value={form.mood}
                onChange={(e) => set("mood", e.target.value)}
                aria-label={t("Mood", "心情")}
              >
                <option value="">{t("None", "无")}</option>
                {MOODS.map((mood) => (
                  <option key={mood.value} value={mood.value}>
                    {moodMeta(mood.value, language).label}
                  </option>
                ))}
              </select>
            </label>
          </div>
          <div className="px-form__row">
            <span className="px-form__label">{t("Tags", "标签")}</span>
            {tagList.loading ? (
              <p className="px-form__hint">{t("Loading tags…", "正在加载标签…")}</p>
            ) : allTags.length > 0 ? (
              <div className="notes-editor__tags">
                {allTags.map((tag) => (
                  <button
                    key={tag.id}
                    type="button"
                    className="px-chip"
                    aria-pressed={form.tagIds.includes(tag.id)}
                    aria-label={t(`Toggle tag ${tag.name}`, `切换标签 ${tag.name}`)}
                    onClick={() => toggleTag(tag.id)}
                  >
                    {tag.name}
                  </button>
                ))}
              </div>
            ) : (
              <div>{t("No tags yet", "暂无标签")} <HelpPopover label={t("Tags", "标签")}>{t("Type a name below and press Enter.", "在下方输入名称并按回车创建。")}</HelpPopover></div>
            )}
            <div className="notes-editor__new-tag">
              <PixelInput
                value={newTagName}
                onChange={(e) => setNewTagName(e.target.value)}
                onKeyDown={(e) => {
                  // Enter creates/selects the tag; it must never submit the note.
                  if (e.key !== "Enter") return;
                  e.preventDefault();
                  if (newTagName.trim() === "" || tagCreate.busy) return;
                  void tagCreate.mutate();
                }}
                aria-label={t("New tag name", "新标签名称")}
                placeholder={t("New tag…", "新标签…")}
              />
              <PixelButton
                size="sm"
                variant="secondary"
                disabled={newTagName.trim() === "" || tagCreate.busy}
                onClick={() => void tagCreate.mutate()}
              >
                {t("Add", "添加")}
              </PixelButton>
            </div>
            {tagCreate.error ? (
              <StatusMessage tone="error">
                <p>{tagCreate.error}</p>
              </StatusMessage>
            ) : null}
          </div>
          <label className="px-form__row">
            <span className="px-form__label">{t("Content", "内容")}</span>
            <textarea
              className="px-textarea notes-editor__content"
              value={form.content}
              onChange={(e) => set("content", e.target.value)}
              aria-label={t("Note content", "笔记内容")}
              placeholder={t("What's on your mind?", "记录此刻的想法")}
              required
            />
          </label>
          <label className="notes-check">
            <input
              type="checkbox"
              className="px-checkbox"
              checked={form.pinned}
              onChange={(e) => set("pinned", e.target.checked)}
            />
            {t("Pinned", "置顶")}
          </label>
          {save.error ? (
            <StatusMessage tone="error">
              <p>{save.error}</p>
            </StatusMessage>
          ) : null}
          <div className="px-dialog__actions">
            {isEdit ? (
              <PixelButton
                variant="danger"
                size="sm"
                className="notes-editor__delete"
                onClick={() => setConfirmingDelete(true)}
                disabled={save.busy}
              >
                <PixelIcon name="trash" /> {t("Delete", "删除")}
              </PixelButton>
            ) : null}
            <PixelButton variant="secondary" size="sm" onClick={() => navigate("/notes")} disabled={save.busy}>
              {t("Cancel", "取消")}
            </PixelButton>
            <PixelButton type="submit" size="sm" disabled={contentBlank || save.busy}>
              {save.busy ? t("Saving…", "保存中…") : isEdit ? t("Save changes", "保存修改") : t("Create note", "创建笔记")}
            </PixelButton>
          </div>
        </form>
      </PixelWindow>
      {confirmingDelete ? (
        <ConfirmDialog
          title={t("Delete note", "删除笔记")}
          message={t("Delete this note? This cannot be undone.", "删除这条笔记？此操作无法撤销。")}
          busy={remove.busy}
          onCancel={() => setConfirmingDelete(false)}
          onConfirm={async () => {
            if (await remove.mutate()) {
              setConfirmingDelete(false);
              navigate("/notes");
            }
          }}
        />
      ) : null}
    </>
  );
}

/** /notes/new (id absent) and /notes/:id (edit) share this page shell. */
export function NoteEditorPage() {
  const { t } = useI18n();
  const displayName = useAppDisplayName({ id: "notes", name: "Notes" });
  const { id } = useParams();
  const isEdit = Boolean(id);
  const note = useAsync(() => (id ? getNote(id) : Promise.resolve(null)), [id ?? "new"]);

  return (
    <div className="page" data-app="notes">
      <header className="page-header">
        <h1 className="page-header__title">{isEdit ? t("Edit Note", "编辑笔记") : t("New Note", "新笔记")}</h1>
        <p className="page-header__subtitle">{displayName}</p>
        <div className="page-header__actions">
          <Link to="/notes" className="px-button px-button--secondary px-button--sm">
            <PixelIcon name="back" /> {t("Notes", "笔记")}
          </Link>
        </div>
      </header>

      {isEdit && note.loading ? (
        <LoadingState label={t("Loading note…", "正在加载笔记…")} />
      ) : isEdit && note.error ? (
        <StatusMessage tone="error">
          <p>{note.error}</p>
          <div className="page-header__actions">
            <PixelButton size="sm" variant="secondary" onClick={note.reload}>
              {t("Retry", "重试")}
            </PixelButton>
            <Link to="/notes" className="px-button px-button--secondary px-button--sm">
              {t("Back to Notes", "返回笔记")}
            </Link>
          </div>
        </StatusMessage>
      ) : (
        <NoteEditorForm key={id ?? "new"} note={note.data} />
      )}
    </div>
  );
}
