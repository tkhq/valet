import { useState } from "react";
import { AlertTriangle, ChevronDown, HelpCircle, KeyRound, X } from "lucide-react";
import type { DecisionGate } from "@valet/api/wire";
import { Button, Spinner, Textarea, Tooltip } from "~/components/primitives";
import { useResolveDecision, useWithdrawDecision } from "~/api/queries";
import { useMe } from "~/api/settings";
import { cn } from "~/lib/cn";

const GATE_ACTION_ALWAYS_ALLOW = "always_allow";
const ALWAYS_ALLOW_TOOLTIP = "Only an org admin can always-allow this action.";
const MAX_APPROVAL_PREVIEW_BYTES = 16_000;

export function DecisionGateCard({
  sessionId,
  gate,
}: {
  sessionId: string;
  gate: DecisionGate;
}) {
  const resolve = useResolveDecision(sessionId);
  const withdraw = useWithdrawDecision(sessionId);
  const meQ = useMe();
  const isAdmin = meQ.data?.orgRole === "admin";
  const [value, setValue] = useState("");
  const busy = resolve.isPending || withdraw.isPending;
  const Icon = ICON_FOR_TYPE[gate.type];
  const tone = TONE_FOR_TYPE[gate.type];
  const approval = gate.approval;
  const approvalReviewIncomplete = approval !== undefined && isApprovalReviewIncomplete(approval);
  const dismissLabel = DISMISS_LABEL[gate.type];

  async function pickAction(actionId: string) {
    if (busy) return;
    try {
      await resolve.mutateAsync({ gateId: gate.id, body: { actionId } });
    } catch (err) {
      console.error("resolve gate failed:", err);
    }
  }

  async function submitValue() {
    const nextValue = value.trim();
    if (!nextValue || busy) return;
    try {
      await resolve.mutateAsync({ gateId: gate.id, body: { value: nextValue } });
      setValue("");
    } catch (err) {
      console.error("resolve gate failed:", err);
    }
  }

  async function cancel() {
    if (busy) return;
    try {
      await withdraw.mutateAsync({ gateId: gate.id });
    } catch (err) {
      console.error("withdraw gate failed:", err);
    }
  }

  return (
    <section
      className={cn(
        "mx-3 mt-3 flex min-h-0 max-h-[calc(100dvh-1.5rem)] flex-col overflow-hidden rounded-md border",
        "border-amber-300 bg-amber-50/70 dark:border-amber-700/60 dark:bg-amber-950/40",
      )}
      aria-labelledby={`gate-${gate.id}-title`}
      aria-live="polite"
    >
      <header className="flex shrink-0 items-start gap-2.5 border-b border-amber-300/70 px-3.5 py-3 dark:border-amber-700/50">
        <span
          className={cn(
            "mt-0.5 inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-full",
            tone.iconBg,
          )}
          aria-hidden="true"
        >
          <Icon className={cn("h-3.5 w-3.5", tone.iconFg)} />
        </span>
        <div className="min-w-0 flex-1">
          <p className={cn("text-[10px] font-semibold uppercase tracking-wider", tone.label)}>
            {LABEL_FOR_TYPE[gate.type]} · agent paused
          </p>
          <h3 id={`gate-${gate.id}-title`} className="mt-0.5 max-h-12 overflow-y-auto break-all text-sm font-semibold text-[--fg]">
            {gate.title}
          </h3>
        </div>
        <button
          type="button"
          onClick={cancel}
          disabled={busy}
          aria-label={dismissLabel}
          className="-mr-1 mt-0.5 shrink-0 text-muted hover:text-[--fg] disabled:opacity-50"
        >
          <X className="h-4 w-4" aria-hidden="true" />
        </button>
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-3.5 py-3">
        {approval ? (
          <ApprovalReview approval={approval} provenance={gate.provenance} />
        ) : (
          <GenericGateReview body={gate.body} provenance={gate.provenance} />
        )}
      </div>

      {gate.type === "question" ? (
        <div className="flex max-h-[35dvh] shrink-0 items-end gap-2 overflow-y-auto border-t border-amber-300/70 px-3.5 py-3 dark:border-amber-700/50">
          <Textarea
            value={value}
            onChange={(e) => setValue(e.target.value)}
            placeholder="Your answer…"
            rows={2}
            className="flex-1 bg-white/70 dark:bg-neutral-900/40"
            disabled={busy}
          />
          <Button onClick={submitValue} disabled={busy || value.trim().length === 0}>
            {busy ? <Spinner size={14} /> : "Submit"}
          </Button>
        </div>
      ) : (
        <div className="flex max-h-[35dvh] shrink-0 flex-wrap gap-2 overflow-y-auto border-t border-amber-300/70 px-3.5 py-3 dark:border-amber-700/50">
          {gate.actions.map((action) => {
            const isAlwaysAllow = action.id === GATE_ACTION_ALWAYS_ALLOW;
            const reviewBlocked = approvalReviewIncomplete && action.approves === true;
            const disabled = busy || reviewBlocked || (isAlwaysAllow && !isAdmin);
            const button = (
              <Button
                key={action.id}
                onClick={() => pickAction(action.id)}
                disabled={disabled}
                variant={action.style === "primary" ? "primary" : action.style === "danger" ? "danger" : "secondary"}
              >
                {busy && resolve.variables?.gateId === gate.id ? <Spinner size={14} /> : null}
                <span className="max-w-full break-all text-center">{action.label}</span>
              </Button>
            );
            if (reviewBlocked) {
              return <Tooltip key={action.id} content="Review the complete request in the action log, then retry this action."><span>{button}</span></Tooltip>;
            }
            if (isAlwaysAllow && !isAdmin) {
              return <Tooltip key={action.id} content={ALWAYS_ALLOW_TOOLTIP}><span>{button}</span></Tooltip>;
            }
            return button;
          })}
        </div>
      )}
    </section>
  );
}

function ApprovalReview({
  approval,
  provenance,
}: {
  approval: NonNullable<DecisionGate["approval"]>;
  provenance?: DecisionGate["provenance"];
}) {
  const argsPreview = boundedPreview(approval.argsPreview);
  const reviewIncomplete = isApprovalReviewIncomplete(approval);
  const facts = [
    ["Tool", approval.toolId],
    ["Service", approval.service],
    ["Risk", approval.riskLevel],
  ].filter((fact): fact is [string, string] => typeof fact[1] === "string" && fact[1] !== "");

  return (
    <div className="space-y-3">
      <p className="break-words text-sm text-[--fg]">{approval.summary ?? (approval.toolId ? `Run ${approval.toolId}.` : "The tool identity is unavailable.")}</p>
      <dl className="grid gap-2 sm:grid-cols-3">
        {facts.map(([label, detail]) => (
          <div key={label} className="min-w-0 rounded border border-amber-300/70 bg-white/50 px-2.5 py-2 dark:border-amber-700/50 dark:bg-neutral-950/20">
            <dt className="text-[10px] font-semibold uppercase tracking-wider text-muted">{label}</dt>
            <dd className="mt-0.5 break-all font-mono text-xs text-[--fg]">{detail}</dd>
          </div>
        ))}
      </dl>
      {provenance && <p className="text-xs text-muted" data-testid="gate-provenance">{provenanceLine(provenance)}</p>}
      <details className="group rounded border border-amber-300/70 bg-white/40 dark:border-amber-700/50 dark:bg-neutral-950/20" data-testid="approval-details">
        <summary className="flex cursor-pointer list-none items-center justify-between gap-3 px-3 py-2 text-xs font-medium text-[--fg] marker:hidden">
          Review request details
          <ChevronDown className="h-4 w-4 shrink-0 transition-transform group-open:rotate-180 motion-reduce:transition-none" aria-hidden="true" />
        </summary>
        <div className="border-t border-amber-300/70 p-3 dark:border-amber-700/50">
          <p className="mb-2 text-xs text-muted">Parameters</p>
          <pre className="max-h-52 overflow-auto overscroll-contain whitespace-pre-wrap break-all rounded bg-ink-wash p-2 text-xs text-[--fg]" tabIndex={0} aria-label="Approval request parameters">
            {argsPreview.text}
          </pre>
          {reviewIncomplete && <p className="mt-2 text-xs text-muted">The complete parameters are not available here. Reject this request and ask the agent to retry with a smaller request.</p>}
        </div>
      </details>
    </div>
  );
}

function boundedPreview(preview: string | undefined): { text: string; truncated: boolean } {
  if (preview === undefined) return { text: "{}", truncated: false };
  const encoder = new TextEncoder();
  const suffix = "…";
  const suffixBytes = encoder.encode(suffix).length;
  let bytes = 0;
  let text = "";
  for (const point of preview) {
    const pointBytes = encoder.encode(point).length;
    if (bytes + pointBytes > MAX_APPROVAL_PREVIEW_BYTES - suffixBytes) {
      return { text: `${text}${suffix}`, truncated: true };
    }
    text += point;
    bytes += pointBytes;
  }
  return { text, truncated: false };
}

function isApprovalReviewIncomplete(approval: NonNullable<DecisionGate["approval"]>): boolean {
  return approval.toolId === undefined || approval.toolId.trim() === "" || approval.argsPreview === undefined || approval.argsPreview.trim() === "" || approval.reviewIncomplete === true || boundedPreview(approval.argsPreview).truncated;
}

function GenericGateReview({ body, provenance }: Pick<DecisionGate, "body" | "provenance">) {
  return (
    <div className="space-y-2">
      {body && <p className="whitespace-pre-wrap break-all text-sm text-muted">{body}</p>}
      {provenance && <p className="text-xs text-muted" data-testid="gate-provenance">{provenanceLine(provenance)}</p>}
    </div>
  );
}

function provenanceLine(p: NonNullable<DecisionGate["provenance"]>): string {
  switch (p.source) {
    case "team_policy": return "Gated by a team policy.";
    case "org_policy": return "Gated by an org policy.";
    case "override": return "Gated by your personal policy override.";
    case "runtime_grant": return "Gated by a session grant.";
    case "plugin_default": return "Gated by the plugin's default approval mode.";
    case "risk_default": return "Gated by the action's risk level.";
    case "resolver_error": return "Policy check failed. Approval was requested as a safe fallback.";
    default: return `Gated by policy (${p.source}).`;
  }
}

const ICON_FOR_TYPE = { approval: AlertTriangle, question: HelpCircle, credential_request: KeyRound } as const;
const DISMISS_LABEL: Record<DecisionGate["type"], string> = {
  approval: "Cancel and dismiss approval",
  question: "Cancel and dismiss question",
  credential_request: "Cancel and dismiss credential request",
};
const LABEL_FOR_TYPE: Record<DecisionGate["type"], string> = { approval: "Approval needed", question: "Question", credential_request: "Credential needed" };
const TONE_FOR_TYPE: Record<DecisionGate["type"], { iconBg: string; iconFg: string; label: string }> = {
  approval: { iconBg: "bg-amber-200 dark:bg-amber-900/60", iconFg: "text-amber-800 dark:text-amber-300", label: "text-amber-800 dark:text-amber-300" },
  question: { iconBg: "bg-blue-200 dark:bg-blue-900/60", iconFg: "text-blue-800 dark:text-blue-300", label: "text-blue-800 dark:text-blue-300" },
  credential_request: { iconBg: "bg-violet-200 dark:bg-violet-900/60", iconFg: "text-violet-800 dark:text-violet-300", label: "text-violet-800 dark:text-violet-300" },
};
