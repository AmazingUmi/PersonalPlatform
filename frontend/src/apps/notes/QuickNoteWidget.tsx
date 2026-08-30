import { useState } from "react";
import { Link } from "react-router-dom";
import { PixelBadge } from "../../shared/ui/PixelBadge";
import { PixelButton } from "../../shared/ui/PixelButton";
import { StatusMessage } from "../../shared/ui/StatusMessage";
import { useMutation } from "../../shared/useMutation";
import { createNote } from "./api";

/**
 * Quick Note dashboard widget (worklist §3.6): one textarea + Save. The body
 * posts only `{ content }` — every other field takes the server default
 * (title/mood null, occurredAt now, pinned false, no tags). All controls are
 * native elements (textarea/button/a), so Dashboard's isInteractiveTarget
 * swallows their clicks and the card never navigates on a control press; the
 * Open link is a plain <a> so the guard protects it too (deep-linkable editor
 * route, worklist §3.1).
 */
export function QuickNoteWidget() {
  const [content, setContent] = useState("");
  const [savedId, setSavedId] = useState<string | null>(null);

  const save = useMutation(async () => {
    setSavedId(null);
    const note = await createNote({ content });
    setSavedId(note.id);
    setContent("");
  });

  return (
    <div className="notes-quick">
      <textarea
        className="px-textarea notes-quick__input"
        placeholder="今天突然想到……"
        value={content}
        onChange={(e) => setContent(e.target.value)}
        aria-label="Quick note content"
        rows={3}
      />
      {save.error ? (
        <StatusMessage tone="error">
          <p>{save.error}</p>
        </StatusMessage>
      ) : null}
      <div className="notes-quick__actions">
        <PixelButton
          size="sm"
          disabled={save.busy || content.trim() === ""}
          onClick={() => void save.mutate()}
        >
          {save.busy ? "Saving…" : "Save"}
        </PixelButton>
        {savedId !== null && !save.busy ? (
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
