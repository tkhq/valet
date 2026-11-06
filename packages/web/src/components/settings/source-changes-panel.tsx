import { useState } from "react";
import { ShieldCheck } from "lucide-react";
import { ApiError } from "~/api/client";
import { useMe } from "~/api/settings";
import { useResolveSourceChange, useSourceChanges, type SourceChangeSummary } from "~/api/sources";
import { Badge, Button } from "~/components/primitives";
import { relativeTime } from "~/lib/relative-time";

function decisionError(error: Error): string {
  if (error instanceof ApiError && typeof error.payload === "object" && error.payload !== null && "error" in error.payload && typeof error.payload.error === "string") {
    return error.payload.error;
  }
  return "The decision was not saved. Refresh the page and try again.";
}

/** One line per changed field, so the approver reads what will run. */
function changeLines(change: SourceChangeSummary): string[] {
  const fields = ["name", "externalRef", "parentId", "pullSecretName", "setupCommands", "enabled", "schedule"];
  return fields.flatMap((field) => {
    const value = change.payload[field];
    if (value === undefined || value === null) return [];
    if (field === "setupCommands" && Array.isArray(value)) {
      return value.length === 0 ? ["setupCommands: (none)"] : value.map((cmd) => `setup: ${String(cmd)}`);
    }
    return [`${field}: ${String(value)}`];
  });
}

/**
 * Pending image-source changes. A create or a content change waits here
 * until a different org admin approves it; the requester can withdraw it.
 */
export function SourceChangesPanel() {
  const changes = useSourceChanges();
  const pending = changes.data?.changes ?? [];
  return pending.length === 0 ? null : <PendingChanges pending={pending} />;
}

function PendingChanges({ pending }: { pending: SourceChangeSummary[] }) {
  const me = useMe();
  const resolve = useResolveSourceChange();
  const [error, setError] = useState<string | null>(null);

  function decide(id: string, decision: "approve" | "reject" | "withdraw") {
    setError(null);
    resolve.mutate({ id, decision }, { onError: (err) => setError(decisionError(err)) });
  }

  return (
    <section aria-labelledby="source-changes-title" className="space-y-3">
      <div className="space-y-1">
        <h2 id="source-changes-title" className="flex items-center gap-2 font-display text-xl text-ink">
          <ShieldCheck className="h-5 w-5 text-moss" aria-hidden /> Changes waiting for approval
        </h2>
        <p className="text-sm text-muted">
          Image sources decide what every sandbox runs. A second org admin must approve each new source and each change to its image or setup commands.
        </p>
      </div>
      {error && <p role="alert" className="text-sm text-danger-500">{error}</p>}
      <ul className="divide-y divide-line overflow-hidden rounded-xl border border-line">
        {pending.map((change) => {
          const own = me.data?.id === change.requestedBy;
          return (
            <li key={change.id} className="space-y-2 p-4">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="flex flex-wrap items-center gap-2">
                  <Badge variant="accent">{change.action === "create" ? "New source" : "Change"}</Badge>
                  <span className="text-sm font-semibold text-ink">{change.sourceName}</span>
                  <span className="text-xs text-muted">requested {relativeTime(change.requestedAt)}</span>
                </div>
                <div className="flex gap-2">
                  {own ? (
                    <>
                      <span className="self-center text-xs text-muted">Waiting for another admin</span>
                      <Button variant="secondary" size="sm" disabled={resolve.isPending} onClick={() => decide(change.id, "withdraw")}>Withdraw</Button>
                    </>
                  ) : (
                    <>
                      <Button variant="secondary" size="sm" disabled={resolve.isPending} onClick={() => decide(change.id, "reject")}>Reject</Button>
                      <Button size="sm" disabled={resolve.isPending} onClick={() => decide(change.id, "approve")}>Approve</Button>
                    </>
                  )}
                </div>
              </div>
              <pre className="max-h-40 overflow-auto whitespace-pre-wrap break-words rounded bg-ink-wash p-2 font-mono text-xs text-ink">{changeLines(change).join("\n")}</pre>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
