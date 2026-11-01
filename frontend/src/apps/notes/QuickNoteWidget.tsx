import { useI18n } from "../../shared/i18n";
import { useRef, useState } from "react";
import { Link } from "react-router-dom";
import type { WidgetDensity } from "../../shared/appTypes";
import { PixelBadge } from "../../shared/ui/PixelBadge";
import { PixelButton } from "../../shared/ui/PixelButton";
import { StatusMessage } from "../../shared/ui/StatusMessage";
import { useAsync } from "../../shared/useAsync";
import { useMutation } from "../../shared/useMutation";
import { createNote, listNotes, type NoteView } from "./api";

/** Recent-entry row label: explicit title, else a content preview. */
function recentLabel(note: NoteView, language = "en"): string {
  if (note.title && note.title.trim() !== "") return note.title;
  const preview = note.content.replace(/\s+/g, " ").trim();
  return preview.length > 40 ? `${preview.slice(0, 40)}…` : preview || (language === "zh" ? "无标题" : "Untitled");
}

/**
 * Quick Note dashboard widget (worklist §3.6): one textarea + Save. The body
 * posts only `{ content }` — every other field takes the server default
 * (title/mood null, occurredAt now, pinned false, no tags). All controls are
 * native elements (textarea/button/a), so Dashboard's isInteractiveTarget
 * swallows their clicks and the card never navigates on a control press; the
 * Open link is a plain <a> so the guard protects it too (deep-linkable editor
 * route, worklist §3.1). Information density follows the container's layout
 * context: compact shrinks the input, expanded adds recent entries.
 */
export function QuickNoteWidget({ density = "normal" }: { density?: WidgetDensity }) {
  const { t, language, locale } = useI18n();
  const [content, setContent] = useState("");
  const editRevision = useRef(0);
  const [savedId, setSavedId] = useState<string | null>(null);
  const recent = useAsync(
    () => (density === "expanded" ? listNotes() : Promise.resolve(null)),
    [density],
  );
  const saved = useMutation(async () => {
    const submittedContent = content;
    const submittedRevision = editRevision.current;
    setSavedId(null);
    const note = await createNote({ content: submittedContent });
    setSavedId(note.id);
    // A response acknowledges only its submitted snapshot. Any user edit,
    // including A -> B -> A, leaves the entire current draft intact.
    if (editRevision.current === submittedRevision) setContent("");
    // The loader uses the current density; normal/compact do not fetch a
    // list. Refresh even if an expanded list was pending or failed at submit.
    recent.reload();
  });

  return (
    <div className="notes-quick" data-density={density}>
      <textarea
        className="px-textarea notes-quick__input"
        placeholder={t("A thought to capture…", "今天突然想到……")}
        value={content}
        onChange={(e) => {
          editRevision.current += 1;
          setContent(e.target.value);
        }}
        aria-label={t("Quick note content", "快速笔记内容")}
        rows={density === "compact" ? 2 : 3}
      />
      {saved.error ? (
        <StatusMessage tone="error">
          <p>{saved.error}</p>
        </StatusMessage>
      ) : null}
      {density === "expanded" && recent.data ? (
        <ul className="notes-quick__recent">
          {recent.data.items.slice(0, 3).map((note) => (
            <li key={note.id} className="notes-quick__recent-row">
              <span className="notes-quick__recent-title">{recentLabel(note, language)}</span>
              <span className="notes-quick__recent-date">{new Date(`${note.dayKey}T00:00:00`).toLocaleDateString(locale)}</span>
            </li>
          ))}
        </ul>
      ) : null}
      <div className="notes-quick__actions">
        <PixelButton
          size="sm"
          disabled={saved.busy || content.trim() === ""}
          onClick={() => void saved.mutate()}
        >
          {saved.busy ? t("Saving…", "保存中…") : t("Save", "保存")}
        </PixelButton>
        {savedId !== null && !saved.busy ? (
          <>
            <PixelBadge tone="success">{t("Saved", "已保存")}</PixelBadge>
            <Link
              to={`/notes/${savedId}`}
              className="px-button px-button--secondary px-button--sm"
              onClick={() => setSavedId(null)}
            >
              {t("Open", "打开")}
            </Link>
          </>
        ) : null}
      </div>
    </div>
  );
}
