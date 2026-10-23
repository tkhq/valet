/**
 * Pending policy-gate card for `/workflows/runs/$runId`.
 * Rendered for each `WorkflowPendingGate` with `kind === "policy_gate"`.
 *
 * Split-button: "Approve once" (primary) + chevron trigger opening a
 * DropdownMenu with "Approve for rest of run". "Approve and stop asking"
 * (secondary, confirmed) saves a permission for later runs of this workflow
 * only. Deny is a separate danger button. Note field rides whichever action
 * fires. On 409 the query key is invalidated so the stale card disappears.
 */
import { type ReactElement } from "react";
import { ChevronDown, ShieldAlert } from "lucide-react";
import type { WorkflowPendingGate } from "@valet/api/wire";
import { actionParamsLabel } from "@valet/shared";
import { useMe } from "~/api/settings";
import { useApprovalResponse } from "./use-approval-response";
import { ApiError } from "~/api/client";
import { apiErrorMessage } from "~/api/policies";
import {
  Button,
  Callout,
  cardClass,
  ConfirmDialog,
  Input,
  Spinner,
  Time,
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
} from "~/components/primitives";
import { RiskBadge } from "./risk-badge";
import { GatePayloadPreview, hasGatePayloadPreview, type GateTool } from "~/components/session/gate-payload";
import { cn } from "~/lib/cn";

interface PolicyGateCardProps {
  runId: string;
  gate: WorkflowPendingGate; // kind === "policy_gate"
  confirmActions?: boolean;
}

export function PolicyGateCard({ runId, gate, confirmActions = false }: PolicyGateCardProps): ReactElement {
  const { note, setNote, confirmation, submitted, resolve, respond, confirm, onConfirmationOpenChange } =
    useApprovalResponse(runId, gate.nodeId, gate.iteration, gate.gateId);
  const me = useMe();

  const service = gate.service ?? "";
  const action = gate.action ?? "";
  const serviceAction = service && action ? `${service}.${action}` : gate.nodeId;

  const busy = resolve.isPending;
  // Cut parameters could preview a wrong message, so only whole ones do.
  const previewTool: GateTool | undefined = service && action && isRecord(gate.gateParams) && !gate.gateParamsTruncated
    ? { id: `${service}.${action}`, args: gate.gateParams }
    : undefined;
  const preview = previewTool && hasGatePayloadPreview(previewTool) ? previewTool : undefined;
  const paramsLabel = preview ? undefined : actionParamsLabel(gate.gateParams);
  // Only the action permission stops later runs from asking. A lender's
  // workflow consent covers their account and keeps its own copy.
  const confirmingStopAsking = confirmation?.approved === true && confirmation.scope === "workflow" && !gate.approver;
  const borrowScopeCopy = `Approving this step also lets Valet use your ${gate.serviceDisplayName || service || "shared"} account for later actions in this workflow run, including actions requested by other teammates. Only you can approve use of your account.`;

  function fireApprove(scope: "once" | "run" | "workflow" | "team_account") {
    respond({ approved: true, scope }, confirmActions || scope === "workflow");
  }

  // `ApiError.message` is "{method} {path} → {status}" — the server's {error}
  // body is in `error.payload`. Detect 409-already-resolved by status code, not
  // message text; extract the human-readable server message via `apiErrorMessage`.
  const is409AlreadyResolved =
    resolve.isError &&
    resolve.error instanceof ApiError &&
    resolve.error.status === 409;
  const errorMsg = resolve.isError && resolve.error
    ? is409AlreadyResolved
      ? null // shown as the special already-resolved banner below
      : apiErrorMessage(resolve.error)
    : null;

  const denyMicrocopy =
    gate.onDeny === "skip"
      ? "Denying skips this node; downstream nodes can branch on the denial."
      : "Denying fails this node.";

  // A step that would use a member's shared account answers to that member.
  // Everyone else sees that the request went to them.
  if (gate.approver && gate.approver.userId !== me.data?.id) {
    return (
      <div className={cn(cardClass, "p-4")} role="status">
        <p className="text-sm font-medium text-ink [overflow-wrap:anywhere]">Asked {gate.approver.name ?? "a teammate"} for permission</p>
        <p className="mt-1 text-xs text-muted [overflow-wrap:anywhere]">
          {serviceAction} would use {gate.approver.name ? `${gate.approver.name}'s` : "a teammate's"} shared account. The run continues once they allow it.
        </p>
      </div>
    );
  }

  return (
    <Callout tone="warning" className="space-y-3 p-4">
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
            <code className="min-w-0 break-all font-mono text-sm font-semibold text-ink">{serviceAction}</code>
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
      {paramsLabel && (
        <p className="text-sm [overflow-wrap:anywhere]">
          <span className="text-muted">{paramsLabel.key}: </span>
          <span className="font-medium text-ink">{paramsLabel.value}</span>
        </p>
      )}
      {preview && <GatePayloadPreview tool={preview} />}
      {gate.gateParams != null && (
        <details className="text-xs text-muted">
          <summary className="min-h-11 cursor-pointer select-none py-3 font-medium sm:min-h-0 sm:py-0 text-ink">
            {preview ? "Details" : "Parameters"}
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

      {gate.approver && (
        <p className="text-xs text-muted">{borrowScopeCopy} Always allow for this workflow covers its later runs until someone changes its steps.{gate.approver.allowTeamConsent ? " Always allow for this team covers future threads and runs. Choose Stop sharing in Integrations to revoke it. Action approvals still apply." : ""}</p>
      )}

      {/* Note input */}
      <Input
        aria-label="Optional note"
        value={note}
        onChange={(e) => setNote(e.target.value)}
        placeholder="Optional note"
        disabled={busy}
      />

      {/* Action buttons */}
      <div className="flex flex-wrap items-center gap-3">
        {gate.approver ? (
          <>
          <Button size="sm" onClick={() => fireApprove("run")} disabled={busy}>Allow for this run</Button>
          <Button size="sm" variant="secondary" onClick={() => fireApprove("workflow")} disabled={busy}>Always allow for this workflow</Button>
          {gate.approver.allowTeamConsent && <Button size="sm" variant="secondary" onClick={() => fireApprove("team_account")} disabled={busy}>Always allow for this team</Button>}
          </>
        ) : <>
        {/* Split-button: Approve once + dropdown */}
        <div className="flex items-center">
          <Button
            size="sm"
            className="rounded-r-none"
            onClick={() => fireApprove("once")}
            disabled={busy}
          >
            {busy && submitted?.approved && submitted.scope === "once" ? <Spinner size={12} /> : null}
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
                onSelect={() => fireApprove("run")}
                disabled={busy}
              >
                <div>
                  <div>Approve for rest of run</div>
                  <div className="text-xs text-muted">
                    Covers every later call to {serviceAction} in this run.
                  </div>
                </div>
              </DropdownMenuItem>

            </DropdownMenuContent>
          </DropdownMenu>
        </div>
        <Button size="sm" variant="secondary" onClick={() => fireApprove("workflow")} disabled={busy}>Approve and stop asking</Button>
        </>}

        {/* Deny */}
        <Button size="sm" variant="danger" onClick={() => respond({ approved: false, scope: "once" }, confirmActions)} disabled={busy}>
          {busy && submitted?.approved === false ? <Spinner size={12} /> : null}
          Deny
        </Button>
      </div>

      {/* Deny microcopy */}
      <div className="text-[11px] text-muted">{denyMicrocopy}</div>

      <ConfirmDialog
        open={confirmation !== null}
        onOpenChange={onConfirmationOpenChange}
        title={confirmingStopAsking ? "Stop asking on later runs?" : confirmation?.approved === false ? "Deny this tool action?" : "Allow this tool action?"}
        description={
          confirmation?.approved && gate.approver
            ? confirmation.scope === "workflow"
              ? `Valet can use your ${gate.serviceDisplayName || service || "shared"} account in later runs of this workflow until someone changes its steps or you stop sharing. Action approvals still apply.`
              : borrowScopeCopy
            : confirmingStopAsking
            ? `Valet runs ${serviceAction} now. Later runs of this workflow run ${serviceAction} without asking anyone, until someone changes its steps or resets its saved permissions. Policy rules that require approval still apply.`
            : confirmation?.scope === "run"
            ? `Valet runs ${serviceAction} now and allows later calls in this run.`
            : confirmation?.approved === false
              ? denyMicrocopy
              : `Valet runs ${serviceAction} once with the shown parameters.`
        }
        confirmLabel={confirmingStopAsking ? "Stop asking" : confirmation?.approved === false ? "Deny action" : "Allow action"}
        onConfirm={confirm}
      />

      {/* Footer: timeout + error */}
      {(gate.timeoutAt != null || is409AlreadyResolved || errorMsg != null) && (
        <div className="space-y-1">
          {gate.timeoutAt != null && (
            <div className="text-[11px] text-muted">
              Gate times out <Time ts={gate.timeoutAt} format="absolute" />.
            </div>
          )}
          {is409AlreadyResolved && (
            <div className="text-xs text-muted">
              This gate changed or was already resolved. Refreshing…
            </div>
          )}
          {errorMsg != null && (
            <div className="text-xs text-danger-500">
              {errorMsg}
            </div>
          )}
        </div>
      )}
    </Callout>
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
