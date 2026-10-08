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
import { useLayoutEffect, useRef, useState } from "react";
import { Hand, HelpCircle, KeyRound, Paperclip, X } from "lucide-react";
import type { DecisionGate } from "@valet/api/wire";
import { Badge, Button, Spinner, Textarea, Tooltip, cardClass } from "~/components/primitives";
import { useResolveDecision, useWithdrawDecision } from "~/api/queries";
import { useMe } from "~/api/settings";
import { formatChord } from "~/lib/chat-keybindings";
import { cn } from "~/lib/cn";
import { errorText } from "~/lib/error-text";

import { acceptImages, readImage, filesFromClipboard, toPromptAttachments, IMAGE_ACCEPT_ATTRIBUTE, type ComposerImage } from "./composer-images";
import { ComposerImageStrip } from "./composer-image-strip";

// The gate action id the policy resolver offers on a `require_approval`
// decision that grants an org-wide `allow` policy going forward — the API
// 403s it for non-admins at resolve (`org admin required for
// always_allow`, `routes/messages.ts`). Hardcoded here (not imported) since
// it's a server-internal constant (`policies/service.ts`'s
// `GATE_ACTION_ALWAYS_ALLOW`), not part of the wire contract.
const GATE_ACTION_ALWAYS_ALLOW = "always_allow";
const gateColumnClass = "mx-auto mt-3 w-full min-w-0 max-w-[52rem] shrink-0 px-5 sm:px-8";
const ALWAYS_ALLOW_TOOLTIP = "Only an org admin can always-allow this action.";

export function DecisionGateCard(props: { sessionId: string; gate: DecisionGate }) {
  return <DecisionGateResponse key={`${props.sessionId}:${props.gate.id}`} {...props} />;
}

function DecisionGateResponse({
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
  const [images, setImages] = useState<ComposerImage[]>([]);
  const [reading, setReading] = useState(false);
  const readingRef = useRef(false);
  const picker = useRef<HTMLInputElement>(null);
  const [error, setError] = useState<string | null>(null);

  const busy = resolve.isPending || withdraw.isPending || reading;

  async function addImages(files: File[]) {
    if (busy || readingRef.current) return;
    readingRef.current = true;
    setReading(true);
    const { accepted, rejected } = acceptImages(images, files);
    const added: ComposerImage[] = [];
    for (const file of accepted) {
      try { added.push(await readImage(file)); }
      catch (err) { rejected.push(errorText(err)); }
    }
    setImages((current) => [...current, ...added]);
    setError(rejected.length ? rejected.join(" ") : null);
    readingRef.current = false;
    setReading(false);
  }

  const imageBody = images.length ? { attachments: toPromptAttachments(images) } : {};

  async function pickAction(actionId: string) {
    if (busy) return;
    setError(null);
    try {
      await resolve.mutateAsync({ gateId: gate.id, body: { actionId, ...imageBody } });
    } catch (err) {
      setError(errorText(err));
    }
  }

  async function submitValue() {
    const v = value.trim();
    if ((!v && !images.length) || busy) return;
    setError(null);
    try {
      await resolve.mutateAsync({ gateId: gate.id, body: { value: v, ...imageBody } });
      setValue("");
      setImages([]);
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
      <div className={gateColumnClass}>
        <div className={cn(cardClass, "px-5 py-3")} role="status" aria-live="polite">
          <Badge variant={kind.variant}>Asked {waitingOn.name ?? "a teammate"} for permission</Badge>
          <p className="mt-1.5 text-sm text-muted">
            This needs {waitingOn.name ?? "a teammate"}'s shared account. Valet asked them, and continues once they allow it.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className={gateColumnClass}>
      <div
        className={cardClass}
        role="dialog"
        aria-live="polite"
        aria-busy={busy}
        aria-describedby={gate.body ? `gate-${gate.id}-body` : undefined}
        aria-labelledby={`gate-${gate.id}-title`}
      >
        <header className="flex items-start gap-2.5 px-5 pt-3 pb-2">
          <Icon aria-hidden className="mt-1 h-4 w-4 shrink-0 text-muted" />
          <div className="min-w-0 flex-1">
            <Badge variant={kind.variant}>{kind.label}</Badge>
            <DecisionGateTitle key={`${gate.id}:${gate.title}`} id={`gate-${gate.id}-title`} title={gate.title} />
          </div>
          <Button variant="ghost" size="icon" onClick={cancel} disabled={busy} aria-label="Cancel and dismiss" className="-mr-1">
            <X aria-hidden className="h-3.5 w-3.5" />
          </Button>
        </header>

        {error && <p role="alert" className="px-5 py-2 break-words text-sm text-danger-600">{error} Try again.</p>}

        {gate.body && (
          <div
            id={`gate-${gate.id}-body`}
            role="region"
            tabIndex={0}
            aria-label="Request details"
            className="max-h-[min(14rem,25dvh)] overflow-y-auto px-5 pb-3 text-sm leading-relaxed text-muted whitespace-pre-wrap break-words [overflow-wrap:anywhere]"
          >
            {gate.body}
          </div>
        )}

        {gate.provenance && (
          <div className="px-5 pb-2 text-xs text-muted" data-testid="gate-provenance">
            {provenanceLine(gate.provenance)}
          </div>
        )}

        {busy && <p role="status" className="px-5 pb-2 text-xs text-muted">{reading ? "Reading images…" : withdraw.isPending ? "Dismissing request…" : "Sending response…"}</p>}

        {gate.type === "question" ? (
          <>
          {gate.actions.length > 0 && (
            <div className="px-5 pb-2 flex flex-wrap gap-2">
              {gate.actions.map((a) => (
                <Button key={a.id} variant="secondary" size="sm" onClick={() => pickAction(a.id)} disabled={busy}>{a.label}</Button>
              ))}
            </div>
          )}
          <div className="px-5 pb-3"
            onDragOver={(event) => { if (event.dataTransfer.types.includes("Files")) { event.preventDefault(); event.stopPropagation(); } }}
            onDrop={(event) => { if (event.dataTransfer.files.length) { event.preventDefault(); event.stopPropagation(); void addImages(Array.from(event.dataTransfer.files)); } }}>
            <ComposerImageStrip images={images} onRemove={(id) => { if (!busy) setImages((current) => current.filter((image) => image.id !== id)); }} />
            <input ref={picker} type="file" accept={IMAGE_ACCEPT_ATTRIBUTE} multiple className="sr-only" aria-label="Attach images to answer" disabled={busy}
              onChange={(event) => { void addImages(Array.from(event.target.files ?? [])); event.target.value = ""; }} />
            <div className="flex items-end gap-2">
            <Button variant="ghost" size="icon" aria-label="Attach images" disabled={busy} onClick={() => picker.current?.click()}><Paperclip className="h-4 w-4" /></Button>
            <Textarea
              value={value}
              onChange={(e) => setValue(e.target.value)}
              onPaste={(event) => { const files = filesFromClipboard(event.clipboardData.items); if (files.length) { event.preventDefault(); event.stopPropagation(); void addImages(files); } }}
              onKeyDown={(event) => {
                if (event.key !== "Enter" || !(event.metaKey || event.ctrlKey) || event.altKey || event.shiftKey || event.repeat || event.nativeEvent.isComposing) return;
                event.preventDefault();
                event.stopPropagation();
                void submitValue();
              }}
              aria-label="Your answer"
              placeholder={gate.actions.length > 0 ? "Or type a different answer…" : "Your answer…"}
              rows={2}
              className="flex-1"
              disabled={busy}
            />
            <Button
              size="sm"
              aria-label="Submit"
              onClick={submitValue}
              title={`Submit answer (${formatChord({ code: "Enter", key: "Enter" })})`}
              aria-keyshortcuts="Meta+Enter Control+Enter"
              disabled={busy || (value.trim().length === 0 && images.length === 0)}
            >
              {busy ? <Spinner size={14} /> : "Submit"}
            </Button>
            </div>
          </div>
          </>
        ) : (
          <div className="px-5 pb-3 flex flex-wrap items-center justify-end gap-2">
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
                    a.id === "deny"
                      ? "secondary"
                      : a.style === "primary"
                        ? "primary"
                        : a.style === "danger"
                          ? "danger"
                          : "secondary"
                  }
                >
                  {resolve.isPending && resolve.variables?.gateId === gate.id && resolve.variables.body.actionId === a.id ? (
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
    </div>
  );
}

function DecisionGateTitle({ id, title }: { id: string; title: string }) {
  const heading = useRef<HTMLHeadingElement>(null);
  const toggle = useRef<HTMLButtonElement>(null);
  const [expanded, setExpanded] = useState(false);
  const [truncated, setTruncated] = useState(false);

  useLayoutEffect(() => {
    if (expanded) return;
    let active = true;
    const measure = () => {
      if (!active) return;
      const element = heading.current;
      const next = Boolean(element && element.scrollHeight > element.clientHeight + 1);
      if (!next && document.activeElement === toggle.current) {
        queueMicrotask(() => heading.current?.focus({ preventScroll: true }));
      }
      setTruncated(next);
    };
    measure();
    const observer = typeof ResizeObserver === "undefined" ? undefined : new ResizeObserver(measure);
    observer?.observe(heading.current!);
    void document.fonts?.ready.then(measure).catch(() => {});
    return () => {
      active = false;
      observer?.disconnect();
    };
  }, [expanded, title]);

  return (
    <>
      <h3
        ref={heading}
        id={id}
        tabIndex={expanded ? 0 : -1}
        className={cn(
          "mt-1.5 break-words text-sm font-medium leading-relaxed text-ink [overflow-wrap:anywhere]",
          !expanded ? "line-clamp-3" : "max-h-[min(14rem,25dvh)] overflow-y-auto",
        )}
      >
        {title}
      </h3>
      {truncated && (
        <Button
          ref={toggle}
          variant="ghost"
          size="sm"
          className="-ml-2 mt-0.5"
          aria-controls={id}
          aria-expanded={expanded}
          onClick={() => {
            if (expanded && heading.current) heading.current.scrollTop = 0;
            setExpanded((value) => !value);
          }}
        >
          {expanded ? "Show less" : "Show more"}
        </Button>
      )}
    </>
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
  approval: Hand,
  question: HelpCircle,
  credential_request: KeyRound,
} as const;

const KIND_FOR_TYPE: Record<DecisionGate["type"], { label: string; variant: "warning" | "accent" | "neutral" }> = {
  approval: { label: "Approval requested", variant: "neutral" },
  question: { label: "Question", variant: "accent" },
  credential_request: { label: "Credential needed", variant: "neutral" },
};
