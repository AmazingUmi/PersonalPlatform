import { useState } from "react";
import { Link } from "react-router-dom";
import type { WidgetDensity } from "../../shared/appTypes";
import { PixelBadge } from "../../shared/ui/PixelBadge";
import { PixelButton } from "../../shared/ui/PixelButton";
import { StatusMessage } from "../../shared/ui/StatusMessage";
import { useAsync } from "../../shared/useAsync";
import { useMutation } from "../../shared/useMutation";
import { createNote, listNotes, type NoteView } from "./api";

/** Recent-entry row label: explicit title, else a content preview. */
function recentLabel(note: NoteView): string {
  if (note.title && note.title.trim() !== "") return note.title;
  const preview = note.content.replace(/\s+/g, " ").trim();
  return preview.length > 40 ? `${preview.slice(0, 40)}…` : preview || "Untitled";
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
  const [content, setContent] = useState("");
  const [savedId, setSavedId] = useState<string | null>(null);
  const recent = useAsync(
    () => (density === "expanded" ? listNotes() : Promise.resolve(null)),
    [density],
  );
  const saved = useMutation(async () => {
    setSavedId(null);
    const note = await createNote({ content });
    setSavedId(note.id);
    setContent("");
    // A freshly saved note belongs at the top of the expanded recent list.
    if (recent.data) void recent.reload();
  });

  return (
    <div className="notes-quick" data-density={density}>
      <textarea
        className="px-textarea notes-quick__input"
        placeholder="今天突然想到……"
        value={content}
        onChange={(e) => setContent(e.target.value)}
        aria-label="Quick note content"
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
              <span className="notes-quick__recent-title">{recentLabel(note)}</span>
              <span className="notes-quick__recent-date">{note.dayKey}</span>
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
          {saved.busy ? "Saving…" : "Save"}
        </PixelButton>
        {savedId !== null && !saved.busy ? (
          <>
            <PixelBadge tone="success">Saved</PixelBadge>
            <Link
              to={`/notes/${savedId}`}
              className="px-button px-button--secondary px-button--sm"
              onClick={() => setSavedId(null)}
            >
              Open
            </Link>
          </>
        ) : null}
      </div>
    </div>
  );
}
