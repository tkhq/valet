/**
 * The confirm that deletes a workflow. The workflow list and the workflow
 * editor's More menu both open it, so both ask the same question and show
 * the server's reason when it refuses (a 409 while runs are active).
 */
import { useEffect, useState } from "react";
import { useDeleteWorkflow } from "~/api/workflows";
import { ConfirmDialog } from "~/components/primitives";

export function DeleteWorkflowDialog({ workflow, open, onOpenChange, onDeleted }: {
  workflow: { id: string; name: string };
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Runs after the server deletes the workflow, once the dialog closes. */
  onDeleted?: () => void;
}) {
  const del = useDeleteWorkflow();
  const [error, setError] = useState<string | null>(null);
  // Each open starts without the last attempt's error.
  useEffect(() => {
    if (open) setError(null);
  }, [open]);

  async function handleDelete() {
    setError(null);
    try {
      await del.mutateAsync(workflow.id);
      onOpenChange(false);
      onDeleted?.();
    } catch (err) {
      // 409 = active runs; show the server's message. The dialog stays open
      // so the message sits beside the button that caused it.
      setError(err instanceof Error ? err.message : "Could not delete the workflow. Try again.");
    }
  }

  return (
    <ConfirmDialog
      open={open}
      onOpenChange={onOpenChange}
      title={`Delete "${workflow.name}"?`}
      description="The workflow, its saved versions, and what starts it are deleted. Settled run history is kept."
      confirmLabel="Delete workflow"
      pendingLabel="Deleting…"
      pending={del.isPending}
      error={error}
      onConfirm={() => void handleDelete()}
    />
  );
}
