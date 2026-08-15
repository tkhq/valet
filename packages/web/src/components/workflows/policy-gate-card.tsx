/**
 * Pending policy-gate card for `/workflows/runs/$runId`.
 * Rendered for each `WorkflowPendingGate` with `kind === "policy_gate"`.
 *
 * Split-button: "Approve once" (primary) + chevron trigger opening a
 * DropdownMenu with "Approve for rest of run" and "Always allow" (admin
 * only). Deny is a separate danger button. Note field rides whichever action
 * fires. On 409 the query key is invalidated so the stale card disappears.
 */
import { useState } from "react";
import { ChevronDown, ShieldAlert } from "lucide-react";
import type { WorkflowPendingGate } from "@valet/api/wire";
import { useQueryClient } from "@tanstack/react-query";
import { useResolveApproval, qkWorkflows } from "~/api/workflows";
import { useMe } from "~/api/settings";
import {
  Button,
  Spinner,
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
} from "~/components/primitives";
import { RiskBadge } from "./risk-badge";
import { cn } from "~/lib/cn";

// 409 response copies (from the route contract in packages/api/src/routes/workflows.ts)
const MSG_ALREADY_RESOLVED = "This gate was already resolved. Refresh the run page.";

export interface PolicyGateCardProps {
  runId: string;
  gate: WorkflowPendingGate; // kind === "policy_gate"
}

export function PolicyGateCard({ runId, gate }: PolicyGateCardProps): JSX.Element {
  const [note, setNote] = useState("");
  const [confirmAlways, setConfirmAlways] = useState(false);
  const [busyScope, setBusyScope] = useState<"once" | "run" | "always" | "deny" | null>(null);
  const resolve = useResolveApproval(runId);
  const meQ = useMe();
  const qc = useQueryClient();
  const isAdmin = meQ.data?.orgRole === "admin";

  const service = gate.service ?? "";
  const action = gate.action ?? "";
  const serviceAction = service && action ? `${service}.${action}` : gate.nodeId;

  const busy = resolve.isPending;

  function fire(approved: boolean, scope: "once" | "run" | "always") {
    const scopeKey = approved ? scope : "deny";
    setBusyScope(scopeKey as typeof busyScope);
    resolve.mutate({
      nodeId: gate.nodeId,
      body: {
        approved,
        scope,
        note: note.trim() || undefined,
        iteration: gate.iteration,
      },
    });
    setConfirmAlways(false);
  }

  function handleDeny() {
    setBusyScope("deny");
    resolve.mutate({
      nodeId: gate.nodeId,
      body: {
        approved: false,
        scope: "once",
        note: note.trim() || undefined,
        iteration: gate.iteration,
      },
    });
  }

  // 409 → invalidate the run query so stale card disappears
  const errorMsg =
    resolve.isError && resolve.error
      ? (resolve.error as { message?: string }).message ?? String(resolve.error)
      : null;
  const is409 = errorMsg != null && errorMsg.includes("already resolved");

  if (is409) {
    void qc.invalidateQueries({ queryKey: qkWorkflows.run(runId) });
  }

  const denyMicrocopy =
    gate.onDeny === "skip"
      ? "Denying skips this node; downstream nodes can branch on the denial."
      : "Denying fails this node.";

  return (
    <div className="rounded-md border border-amber-300 bg-amber-50/70 dark:border-amber-700/60 dark:bg-amber-950/40 p-4 space-y-3">
      {/* Header */}
      <div className="flex items-start gap-2.5">
        <span className="mt-0.5 inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-amber-200 dark:bg-amber-900/60">
          <ShieldAlert className="h-3.5 w-3.5 text-amber-800 dark:text-amber-300" />
        </span>
        <div className="min-w-0 flex-1 space-y-0.5">
          <div className="text-[10px] font-semibold uppercase tracking-wider text-amber-800 dark:text-amber-300">
            Policy gate
            {gate.iteration != null ? ` • Iteration ${gate.iteration}` : ""}
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <code className="font-mono text-sm font-semibold text-ink">{serviceAction}</code>
            {gate.riskLevel && <RiskBadge level={gate.riskLevel} />}
          </div>
        </div>
      </div>

      {/* Provenance */}
      {gate.provenance === "resolver_error" && (
        <div className="text-xs text-amber-800 dark:text-amber-300">
          Policy check failed — approval requested as a safe fallback.
        </div>
      )}

      {/* Params */}
      {gate.gateParams != null && (
        <details className="text-xs text-muted">
          <summary className="cursor-pointer select-none font-medium text-ink">
            Parameters
          </summary>
          <pre className="mt-1.5 overflow-x-auto rounded bg-[--bg] p-2 font-mono text-xs text-muted">
            {JSON.stringify(gate.gateParams, null, 2)}
          </pre>
          {gate.gateParamsTruncated && (
            <div className="mt-1 text-[11px] text-amber-700 dark:text-amber-400">
              Parameters truncated — only a portion is shown.
            </div>
          )}
        </details>
      )}

      {/* Note input */}
      <input
        type="text"
        value={note}
        onChange={(e) => setNote(e.target.value)}
        placeholder="Optional note"
        disabled={busy}
        className={cn(
          "w-full rounded border border-line bg-[--bg] px-2 py-1.5 text-sm text-ink",
          "placeholder:text-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-moss",
          "disabled:opacity-50",
        )}
      />

      {/* Always-allow confirm step */}
      {confirmAlways && (
        <div className="rounded border border-amber-400 bg-amber-100/80 dark:border-amber-600 dark:bg-amber-900/40 p-3 space-y-2">
          <div className="text-xs font-medium text-ink">
            Allows {serviceAction} for every user and run in this org.{" "}
            <a
              href="/settings/organization"
              className="underline text-moss hover:opacity-80"
            >
              Manage policies
            </a>
          </div>
          <div className="flex gap-2">
            <Button size="sm" onClick={() => fire(true, "always")} disabled={busy}>
              {busy && busyScope === "always" ? <Spinner size={12} /> : null}
              Confirm
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setConfirmAlways(false)} disabled={busy}>
              Cancel
            </Button>
          </div>
        </div>
      )}

      {/* Action buttons */}
      <div className="flex items-center gap-4">
        {/* Split-button: Approve once + dropdown */}
        <div className="flex items-center">
          <Button
            size="sm"
            className="rounded-r-none"
            onClick={() => fire(true, "once")}
            disabled={busy}
          >
            {busy && busyScope === "once" ? <Spinner size={12} /> : null}
            Approve once
          </Button>

          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                size="sm"
                className="rounded-l-none border-l border-white/25 px-1.5"
                disabled={busy}
                aria-label="More approval options"
              >
                <ChevronDown className="h-3.5 w-3.5" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start">
              <DropdownMenuItem
                role="menuitem"
                onSelect={() => fire(true, "run")}
                disabled={busy}
              >
                <div>
                  <div>Approve for rest of run</div>
                  <div className="text-xs text-muted">
                    Covers every later call to {serviceAction} in this run.
                  </div>
                </div>
              </DropdownMenuItem>
              <DropdownMenuItem
                role="menuitem"
                onSelect={() => {
                  if (isAdmin) setConfirmAlways(true);
                }}
                disabled={!isAdmin || busy}
                aria-disabled={!isAdmin || undefined}
                data-disabled={!isAdmin ? "true" : undefined}
              >
                <div>
                  <div>
                    Always allow{!isAdmin ? " (org admin only)" : ""}
                  </div>
                  <div className="text-xs text-muted">
                    Writes a durable org-wide allow policy.
                  </div>
                </div>
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>

        {/* Deny */}
        <Button size="sm" variant="danger" onClick={handleDeny} disabled={busy}>
          {busy && busyScope === "deny" ? <Spinner size={12} /> : null}
          Deny
        </Button>
      </div>

      {/* Deny microcopy */}
      <div className="text-[11px] text-muted">{denyMicrocopy}</div>

      {/* Footer: timeout + error */}
      {(gate.timeoutAt != null || errorMsg != null) && (
        <div className="space-y-1">
          {gate.timeoutAt != null && (
            <div className="text-[11px] text-muted">
              Gate times out {new Date(gate.timeoutAt).toLocaleString()}.
            </div>
          )}
          {errorMsg != null && (
            <div className="text-xs text-danger-500">
              {is409 ? "This gate was already resolved. Refreshing…" : errorMsg}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
