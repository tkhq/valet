/**
 * Renders a pending DecisionGate as an inline card above the Composer.
 *
 * The agent is paused on `blocked_on_decision_gate` while this is showing —
 * the user must choose an action (approval / credential_request) or supply
 * a value (question) for the engine to resume the suspended turn.
 *
 * Scoping: the parent passes the gate that belongs to the *active* thread.
 * If the user switches threads, this component unmounts; the gate keeps
 * pending in the store and the agent stays blocked until the user comes
 * back and answers — matching the engine's per-thread suspend model.
 */
import { useState } from "react";
import { AlertTriangle, HelpCircle, KeyRound, X } from "lucide-react";
import type { DecisionGate } from "@valet/api/wire";
import { Badge, Button, Spinner, Textarea, Tooltip, cardClass } from "~/components/primitives";
import { useResolveDecision, useWithdrawDecision } from "~/api/queries";
import { useMe } from "~/api/settings";
import { formatChord } from "~/lib/chat-keybindings";
import { cn } from "~/lib/cn";
import { errorText } from "~/lib/error-text";

// The gate action id the policy resolver offers on a `require_approval`
// decision that grants an org-wide `allow` policy going forward — the API
// 403s it for non-admins at resolve (`org admin required for
// always_allow`, `routes/messages.ts`). Hardcoded here (not imported) since
// it's a server-internal constant (`policies/service.ts`'s
// `GATE_ACTION_ALWAYS_ALLOW`), not part of the wire contract.
const GATE_ACTION_ALWAYS_ALLOW = "always_allow";
const ALWAYS_ALLOW_TOOLTIP = "Only an org admin can always-allow this action.";

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
  const [error, setError] = useState<string | null>(null);

  const busy = resolve.isPending || withdraw.isPending;

  async function pickAction(actionId: string) {
    if (busy) return;
    setError(null);
    try {
      await resolve.mutateAsync({ gateId: gate.id, body: { actionId } });
    } catch (err) {
      setError(errorText(err));
    }
  }

  async function submitValue() {
    const v = value.trim();
    if (!v || busy) return;
    setError(null);
    try {
      await resolve.mutateAsync({ gateId: gate.id, body: { value: v } });
      setValue("");
    } catch (err) {
      setError(errorText(err));
    }
  }

  async function cancel() {
    if (busy) return;
    setError(null);
    try {
      await withdraw.mutateAsync({ gateId: gate.id });
    } catch (err) {
      setError(errorText(err));
    }
  }

  const Icon = ICON_FOR_TYPE[gate.type];
  const kind = KIND_FOR_TYPE[gate.type];
  // A gate asking to use a member's shared account answers to that member.
  // Everyone else sees that the request went to them.
  const waitingOn = gate.approver && gate.approver.userId !== meQ.data?.id ? gate.approver : undefined;
  if (waitingOn) {
    return (
      <div className={cn(cardClass, "mx-3 mt-3 px-3.5 py-3")} role="status" aria-live="polite">
        <Badge variant={kind.variant}>Asked {waitingOn.name ?? "a teammate"} for permission</Badge>
        <p className="mt-1.5 text-sm text-muted">
          This needs {waitingOn.name ?? "a teammate"}'s shared account. Valet asked them, and continues once they allow it.
        </p>
      </div>
    );
  }

  return (
    <div
      className={cn(cardClass, "mx-3 mt-3")}
      role="dialog"
      aria-live="polite"
      aria-labelledby={`gate-${gate.id}-title`}
    >
      <header className="flex items-start gap-2.5 px-3.5 pt-3 pb-1.5">
        <Icon aria-hidden className="mt-1 h-4 w-4 shrink-0 text-muted" />
        <div className="min-w-0 flex-1">
          <Badge variant={kind.variant}>{kind.label} · Valet is waiting</Badge>
          <h3 id={`gate-${gate.id}-title`} className="mt-1.5 text-sm font-medium text-ink">
            {gate.title}
          </h3>
        </div>
        <Button variant="ghost" size="icon" onClick={cancel} disabled={busy} aria-label="Cancel and dismiss" className="-mr-1">
          <X aria-hidden className="h-3.5 w-3.5" />
        </Button>
      </header>

      {error && <p role="alert" className="px-3.5 py-2 text-sm text-danger-600">{error}</p>}

      {gate.body && (
        <div className="pl-10 pr-3.5 pb-2 text-sm text-muted whitespace-pre-wrap">
          {gate.body}
        </div>
      )}

      {gate.provenance && (
        <div className="pl-10 pr-3.5 pb-2 text-xs text-muted" data-testid="gate-provenance">
          {provenanceLine(gate.provenance)}
        </div>
      )}

      {gate.type === "question" ? (
        <>
        {gate.actions.length > 0 && (
          <div className="pl-10 pr-3.5 pb-2 flex flex-wrap gap-2">
            {gate.actions.map((a) => (
              <Button key={a.id} variant="secondary" size="sm" onClick={() => pickAction(a.id)} disabled={busy}>{a.label}</Button>
            ))}
          </div>
        )}
        <div className="pl-10 pr-3.5 pb-3 flex items-end gap-2">
          <Textarea
            value={value}
            onChange={(e) => setValue(e.target.value)}
            onKeyDown={(event) => {
              if (event.key !== "Enter" || !(event.metaKey || event.ctrlKey) || event.altKey || event.shiftKey || event.repeat || event.nativeEvent.isComposing) return;
              event.preventDefault();
              event.stopPropagation();
              void submitValue();
            }}
            placeholder={gate.actions.length > 0 ? "Or type a different answer…" : "Your answer…"}
            rows={2}
            className="flex-1"
            disabled={busy}
          />
          <Button
            size="sm"
            onClick={submitValue}
            title={`Submit answer (${formatChord({ code: "Enter", key: "Enter" })})`}
            aria-keyshortcuts="Meta+Enter Control+Enter"
            disabled={busy || value.trim().length === 0}
          >
            {busy ? <Spinner size={14} /> : "Submit"}
          </Button>
        </div>
        </>
      ) : (
        <div className="pl-10 pr-3.5 pb-3 flex flex-wrap gap-2">
          {gate.actions.map((a) => {
            const isAlwaysAllow = a.id === GATE_ACTION_ALWAYS_ALLOW;
            const disabled = busy || (isAlwaysAllow && !isAdmin);
            const button = (
              <Button
                key={a.id}
                size="sm"
                onClick={() => pickAction(a.id)}
                disabled={disabled}
                variant={
                  a.style === "primary"
                    ? "primary"
                    : a.style === "danger"
                      ? "danger"
                      : "secondary"
                }
              >
                {busy && resolve.variables?.gateId === gate.id ? (
                  <Spinner size={14} />
                ) : null}
                <span>{a.label}</span>
              </Button>
            );
            // `isAdmin` reads `false` while `useMe()` is still loading —
            // fail-closed (disabled + tooltip) rather than briefly offering
            // a button the API will 403.
            if (isAlwaysAllow && !isAdmin) {
              return (
                <Tooltip key={a.id} content={ALWAYS_ALLOW_TOOLTIP}>
                  <span>{button}</span>
                </Tooltip>
              );
            }
            return button;
          })}
        </div>
      )}
    </div>
  );
}

/** One line naming the precedence rung that gated this call. Policy/override
 * rungs link nowhere from here (the Action Log carries the row links); this
 * is the live "why" the spec's decision 4 promised. */
function provenanceLine(p: NonNullable<DecisionGate["provenance"]>): string {
  // Cases mirror the engine's `PolicyProvenanceSource` values exactly.
  switch (p.source) {
    case "team_policy":
      return "Gated by a team policy.";
    case "org_policy":
      return "Gated by an org policy.";
    case "override":
      return "Gated by your personal policy override.";
    case "runtime_grant":
      return "Gated by a runtime grant.";
    case "plugin_default":
      return "Gated by the plugin's default approval mode.";
    case "risk_default":
      return "Gated by the action's risk level.";
    case "resolver_error":
      return "Policy check failed — approval requested as a safe fallback.";
    default:
      return `Gated by policy (${p.source}).`;
  }
}

const ICON_FOR_TYPE = {
  approval: AlertTriangle,
  question: HelpCircle,
  credential_request: KeyRound,
} as const;

const KIND_FOR_TYPE: Record<DecisionGate["type"], { label: string; variant: "warning" | "accent" | "neutral" }> = {
  approval: { label: "Approval needed", variant: "warning" },
  question: { label: "Question", variant: "accent" },
  credential_request: { label: "Credential needed", variant: "neutral" },
};
