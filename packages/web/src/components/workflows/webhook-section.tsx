import { useState } from "react";
import { Check, Copy } from "lucide-react";
import { Button, ConfirmDialog, ErrorRow, LoadingRow } from "~/components/primitives";
import { useDeleteWorkflowWebhook, useMintWorkflowWebhook, useWorkflowWebhook } from "~/api/workflows";
import { errorText } from "~/lib/error-text";

/**
 * The webhook trigger for one workflow: mint, copy, rotate, delete. The
 * URL carries the bearer secret, so rotate and delete both confirm — the
 * old URL stops working the moment either lands.
 */
export function WebhookSection({ workflowId }: { workflowId: string }) {
  const webhookQ = useWorkflowWebhook(workflowId);
  const mint = useMintWorkflowWebhook(workflowId);
  const del = useDeleteWorkflowWebhook(workflowId);
  const [copied, setCopied] = useState(false);
  const [confirming, setConfirming] = useState<"rotate" | "delete" | null>(null);

  const hook = webhookQ.data;
  const url = hook
    ? `${window.location.origin}/api/hooks/workflows/${workflowId}/${hook.hookId}`
    : null;

  async function copy() {
    if (!url) return;
    await navigator.clipboard.writeText(url);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  }

  return (
    <section>
      <h3 className="text-xs font-medium uppercase tracking-wide text-muted">Webhook</h3>
      <p className="mt-1 text-xs text-muted">
        A POST to this URL starts a run with the request body as input. The URL carries the
        secret — share it only with the caller.
      </p>

      {webhookQ.isLoading && <LoadingRow className="mt-2 py-0 text-xs" />}
      {webhookQ.error != null && (
        <ErrorRow className="mt-2 py-0 text-xs">Failed to load the webhook status.</ErrorRow>
      )}

      {!webhookQ.isLoading && hook === null && (
        <Button
          type="button"
          size="sm"
          className="mt-2"
          disabled={mint.isPending}
          onClick={() => mint.mutate()}
        >
          {mint.isPending ? "Creating…" : "Create webhook URL"}
        </Button>
      )}

      {url && (
        <div className="mt-2 space-y-2">
          <div className="flex items-center gap-1.5">
            <code className="min-w-0 flex-1 truncate rounded bg-neutral-50 px-2 py-1.5 font-mono text-xs text-ink dark:bg-neutral-900">
              {url}
            </code>
            <Button type="button" size="sm" variant="ghost" aria-label="Copy webhook URL" onClick={() => void copy()}>
              {copied ? <Check className="h-3.5 w-3.5" aria-hidden /> : <Copy className="h-3.5 w-3.5" aria-hidden />}
            </Button>
          </div>
          <div className="flex items-center gap-2">
            <Button
              type="button"
              size="sm"
              variant="secondary"
              disabled={mint.isPending}
              onClick={() => setConfirming("rotate")}
            >
              Rotate
            </Button>
            <Button
              type="button"
              size="sm"
              variant="ghost"
              disabled={del.isPending}
              onClick={() => setConfirming("delete")}
            >
              Delete
            </Button>
          </div>
        </div>
      )}

      {mint.error && <p className="mt-2 text-xs text-danger-500">{errorText(mint.error)}</p>}
      {del.error && <p className="mt-2 text-xs text-danger-500">{errorText(del.error)}</p>}

      <ConfirmDialog
        open={confirming === "rotate"}
        onOpenChange={(open) => setConfirming(open ? "rotate" : null)}
        title="Rotate the webhook URL?"
        description="The current URL stops working immediately. Callers must switch to the new URL."
        confirmLabel="Rotate URL"
        pending={mint.isPending}
        onConfirm={() => mint.mutate(undefined, { onSuccess: () => setConfirming(null) })}
      />
      <ConfirmDialog
        open={confirming === "delete"}
        onOpenChange={(open) => setConfirming(open ? "delete" : null)}
        title="Delete the webhook?"
        description="Callers holding the URL get 404s. Mint a new URL to re-enable webhook starts."
        confirmLabel="Delete webhook"
        pendingLabel="Deleting…"
        pending={del.isPending}
        onConfirm={() => del.mutate(undefined, { onSuccess: () => setConfirming(null) })}
      />
    </section>
  );
}
