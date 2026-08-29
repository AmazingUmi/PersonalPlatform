import { useEffect } from "react";
import { PixelButton } from "./PixelButton";
import { PixelWindow } from "./PixelWindow";

interface ConfirmDialogProps {
  title: string;
  message: string;
  confirmLabel?: string;
  cancelLabel?: string;
  busy?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}

/**
 * Pixel-styled confirmation for destructive actions (FP-7.3). Focuses the
 * cancel button by default so a stray Enter never confirms a delete.
 */
export function ConfirmDialog({
  title,
  message,
  confirmLabel = "Delete",
  cancelLabel = "Cancel",
  busy = false,
  onConfirm,
  onCancel,
}: ConfirmDialogProps) {
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !busy) onCancel();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [busy, onCancel]);

  return (
    <div className="px-dialog-backdrop" role="presentation" onClick={(e) => e.stopPropagation()}>
      <PixelWindow
        title={title}
        icon="warning"
        accent="danger"
        className="px-dialog"
        data-testid="confirm-dialog"
      >
        <p className="px-dialog__message">{message}</p>
        <div className="px-dialog__actions">
          <PixelButton variant="secondary" size="sm" onClick={onCancel} disabled={busy}>
            {cancelLabel}
          </PixelButton>
          <PixelButton variant="danger" size="sm" onClick={onConfirm} disabled={busy} autoFocus>
            {busy ? "Working…" : confirmLabel}
          </PixelButton>
        </div>
      </PixelWindow>
    </div>
  );
}
