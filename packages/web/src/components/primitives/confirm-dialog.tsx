import type { ReactNode } from "react";
import { Button } from "./button.js";
import { Dialog, DialogContent, DialogFooter } from "./dialog.js";

/**
 * One confirm step before a destructive or hard-to-reverse action. Replaces
 * per-panel copies of the same Dialog + Cancel/danger-button footer (and
 * bare `window.confirm`, which cannot show pending state or a server
 * error).
 */
export function ConfirmDialog({
  open,
  onOpenChange,
  title,
  description,
  confirmLabel,
  pendingLabel,
  pending = false,
  error,
  onConfirm,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description: string;
  confirmLabel: string;
  /** Button text while `pending`; defaults to `confirmLabel`. */
  pendingLabel?: string;
  pending?: boolean;
  error?: ReactNode;
  onConfirm: () => void;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent title={title} description={description}>
        <DialogFooter>
          <Button type="button" variant="secondary" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button type="button" variant="danger" disabled={pending} onClick={onConfirm}>
            {pending ? (pendingLabel ?? confirmLabel) : confirmLabel}
          </Button>
        </DialogFooter>
        {error != null && <p className="text-xs text-danger-500">{error}</p>}
      </DialogContent>
    </Dialog>
  );
}
