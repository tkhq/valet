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
import { ExpiryCountdown } from "./expiry-countdown";
import { rememberGateChoice } from "./gate-outcome";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { ChevronDown, ChevronUp, Hand, HelpCircle, KeyRound, Paperclip, X } from "lucide-react";
import type { DecisionGate } from "@valet/api/wire";
import { Badge, Button, Spinner, StatusDot, Textarea, Tooltip, cardClass } from "~/components/primitives";
import { useResolveDecision, useWithdrawDecision } from "~/api/queries";
import { useMe } from "~/api/settings";
import { formatChord } from "~/lib/chat-keybindings";
import { cn } from "~/lib/cn";
import { errorText } from "~/lib/error-text";

import { acceptImages, readImage, filesFromClipboard, toPromptAttachments, IMAGE_ACCEPT_ATTRIBUTE, type ComposerImage } from "./composer-images";
import { ComposerImageStrip } from "./composer-image-strip";
import { GatePayloadPreview, hasGatePayloadPreview, splitGateBody } from "./gate-payload";

// The gate action id the policy resolver offers on a `require_approval`
// decision that grants an org-wide `allow` policy going forward — the API
// 403s it for non-admins at resolve (`org admin required for
// always_allow`, `routes/messages.ts`). Hardcoded here (not imported) since
// it's a server-internal constant (`policies/service.ts`'s
// `GATE_ACTION_ALWAYS_ALLOW`), not part of the wire contract.
const GATE_ACTION_ALWAYS_ALLOW = "always_allow";

/** Gate buttons carry labels that can name a long service or a whole
 * question option. They wrap within the card instead of overflowing it. */
const WRAPPING_BUTTON = "h-auto min-h-8 max-w-full whitespace-normal py-1.5 text-left";
const gateColumnClass = "mx-auto mt-3 w-full min-w-0 max-w-[52rem] shrink-0 px-5 sm:px-8";
const ALWAYS_ALLOW_TOOLTIP = "Only an org admin can always-allow this action.";

const COLLAPSED_GATES_KEY = "valet:collapsed-gates";
const MAX_COLLAPSED_GATES = 50;

function readCollapsedIds(): string[] {
  try {
    const ids: unknown = JSON.parse(sessionStorage.getItem(COLLAPSED_GATES_KEY) ?? "[]");
    return Array.isArray(ids) ? ids.filter((id): id is string => typeof id === "string").slice(-MAX_COLLAPSED_GATES) : [];
  } catch { return []; }
}

function readCollapsed(gateId: string): boolean {
  return readCollapsedIds().includes(gateId);
}

function writeCollapsed(gateId: string, collapsed: boolean) {
  try {
    const ids = readCollapsedIds().filter((id) => id !== gateId);
    if (collapsed) ids.push(gateId);
    sessionStorage.setItem(COLLAPSED_GATES_KEY, JSON.stringify(ids.slice(-MAX_COLLAPSED_GATES)));
  } catch { /* storage unavailable: collapse still works for this mount */ }
}

export function DecisionGateCard(props: {
  sessionId: string;
  gate: DecisionGate;
  placement?: "thread" | "notification";
  /** Docked above the composer only: shows the collapse toggle. */
  collapsible?: boolean;
}) {
  return <DecisionGateResponse key={`${props.sessionId}:${props.gate.id}`} {...props} />;
}

function DecisionGateResponse({
  sessionId,
  gate,
  placement = "thread",
  collapsible = false,
}: {
  sessionId: string;
  gate: DecisionGate;
  placement?: "thread" | "notification";
  collapsible?: boolean;
}) {
  const inNotification = placement === "notification";
  const columnClass = inNotification ? "min-w-0 w-full" : gateColumnClass;
  const surfaceClass = inNotification ? "min-w-0" : cardClass;
  const inset = inNotification ? "px-4" : "px-5";
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
  const [expired, setExpired] = useState(() => gate.expiresAt !== undefined && gate.expiresAt <= Date.now());
  // A refreshed gate can carry a new deadline under the same id. While the card
  // is expanded no countdown reports it, so sync on the prop.
  useEffect(() => {
    setExpired(gate.expiresAt !== undefined && gate.expiresAt <= Date.now());
  }, [gate.expiresAt]);
  // "Not now" hides a docked approval in this view only. The gate stays
  // pending, and a different gate shows again.
  const canHide = placement === "thread" && gate.type === "approval";
  const [hiddenGateId, setHiddenGateId] = useState<string | null>(null);
  const hidden = canHide && hiddenGateId === gate.id;
  const notNowButton = useRef<HTMLButtonElement>(null);
  const showButton = useRef<HTMLButtonElement>(null);
  const focusAfterToggle = useRef(false);

  // The toggle removes the focused button, so move focus to its counterpart.
  useEffect(() => {
    if (!focusAfterToggle.current) return;
    focusAfterToggle.current = false;
    (hidden ? showButton : notNowButton).current?.focus();
  }, [hidden]);

  function setHidden(next: boolean, event: { detail: number; clientX: number; clientY: number }) {
    focusAfterToggle.current = true;
    if (event.detail > 0) armSwallow(event);
    setHiddenGateId(next ? gate.id : null);
  }

  // A rejected attachment has nothing to retry, so the collapsed row says so.
  const [attachmentRejected, setAttachmentRejected] = useState(false);
  // Per gate: the card is keyed by gate id, so a new gate starts expanded.
  const [collapsed, setCollapsedState] = useState(() => collapsible && readCollapsed(gate.id));
  useLayoutEffect(() => {
    setCollapsedState(collapsible && readCollapsed(gate.id));
  }, [collapsible, gate.id]);
  const expandButton = useRef<HTMLButtonElement>(null);
  const collapseButton = useRef<HTMLButtonElement>(null);
  const moveFocus = useRef(false);
  function setCollapsed(next: boolean, event: { detail: number; clientX: number; clientY: number }) {
    moveFocus.current = true;
    if (event.detail > 0) armSwallow(event);
    setCollapsedState(next);
    writeCollapsed(gate.id, next);
  }
  // The toggled button unmounts, so hand focus to its counterpart.
  useLayoutEffect(() => {
    if (!moveFocus.current) return;
    moveFocus.current = false;
    (collapsed ? expandButton : collapseButton).current?.focus();
  }, [collapsed]);
  // Latch the decision at press start, even if release is after 600ms.
  // Deliberate taps near the old toggle are ignored by design during that
  // window: 24px for mouse, 48px for touch drift. Taps elsewhere work at once.
  // Keep pointer defaults so compatibility mouse events still reach the guard.
  const disarmSwallow = useRef<(() => void) | null>(null);
  useEffect(() => () => disarmSwallow.current?.(), []);
  function armSwallow(origin: { clientX: number; clientY: number }) {
    const armedAt = performance.now();
    disarmSwallow.current?.();
    const types = ["pointerdown", "pointerup", "mousedown", "mouseup", "click", "dblclick"] as const;
    let press: "pointerdown" | "mousedown" | "click" | undefined;
    let swallow = false;
    const onEvent = (event: MouseEvent) => {
      const { type, detail } = event;
      const pointer = type.startsWith("pointer");
      if (type === "click" && detail === 0) return disarm();
      if (type === "pointerdown" || (type === "mousedown" && press !== "pointerdown")
        || (type === "click" && (press === undefined || press === "click"))) {
        const radius = "pointerType" in event && event.pointerType === "touch" ? 48 : 24;
        swallow = performance.now() - armedAt < 600
          && Math.hypot(event.clientX - origin.clientX, event.clientY - origin.clientY) <= radius;
      }
      // The compatibility mousedown can identify an OS repeat after pointerdown.
      swallow ||= detail > 1;
      if (type === "pointerdown" || type === "mousedown" || type === "click") press = type;
      if (swallow) {
        if (!pointer) event.preventDefault();
        event.stopPropagation();
      } else if (!pointer) {
        disarm();
      }
    };
    function disarm() {
      for (const type of types) document.removeEventListener(type, onEvent, true);
      disarmSwallow.current = null;
    }
    for (const type of types) document.addEventListener(type, onEvent, true);
    disarmSwallow.current = disarm;
  }

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
    setAttachmentRejected(rejected.length > 0);
    readingRef.current = false;
    setReading(false);
  }

  function failAction(err: unknown) {
    setError(errorText(err));
    setAttachmentRejected(false);
  }

  const imageBody = images.length ? { attachments: toPromptAttachments(images) } : {};

  async function pickAction(actionId: string) {
    if (busy) return;
    setError(null);
    try {
      rememberGateChoice(gate.id, actionId);
      await resolve.mutateAsync({ gateId: gate.id, body: { actionId, ...imageBody } });
    } catch (err) {
      failAction(err);
    }
  }

  async function submitValue() {
    const v = value.trim();
    if ((!v && !images.length) || busy) return;
    setError(null);
    try {
      rememberGateChoice(gate.id, "answer");
      await resolve.mutateAsync({ gateId: gate.id, body: { value: v, ...imageBody } });
      setValue("");
      setImages([]);
    } catch (err) {
      failAction(err);
    }
  }

  async function cancel() {
    if (busy) return;
    setError(null);
    try {
      await withdraw.mutateAsync({ gateId: gate.id });
    } catch (err) {
      failAction(err);
    }
  }

  const Icon = ICON_FOR_TYPE[gate.type];
  const kind = KIND_FOR_TYPE[gate.type];
  // Named approvals wait for that member. Policy provenance identifies account borrowing.
  const waitingOn = gate.approver && gate.approver.userId !== meQ.data?.id ? gate.approver : undefined;
  if (waitingOn) {
    return (
      <div className={columnClass}>
        <div className={cn(surfaceClass, inset, "py-3")} role="status" aria-live="polite">
          {inNotification
            ? <p className="text-sm font-medium">Asked {waitingOn.name ?? "a teammate"} for permission</p>
            : <Badge variant={kind.variant}>Asked {waitingOn.name ?? "a teammate"} for permission</Badge>}
          <p className="mt-1.5 text-sm text-muted">
            {gate.provenance?.source === "shared_account"
              ? `This needs ${waitingOn.name ?? "a teammate"}'s shared account. Valet asked them, and continues once they allow it.`
              : `Valet is waiting for ${waitingOn.name ?? "that person"} to review this request.`}
          </p>
        </div>
      </div>
    );
  }

  if (hidden) {
    return (
      <div className={columnClass}>
        <p role="status" className="flex min-w-0 items-center gap-1 text-xs text-muted">
          <span className="min-w-0 truncate" title={gate.title}>Approval waiting: {gate.title}</span>
          <span aria-hidden>·</span>
          <Button ref={showButton} variant="ghost" size="sm" className="shrink-0" onClick={(event) => setHidden(false, event)}>Show</Button>
        </p>
      </div>
    );
  }

  if (collapsed) {
    return (
      <div className={columnClass}>
        <div id={`gate-${gate.id}-card`} className={cn(surfaceClass, "relative border-l-2 border-l-amber-500")} role="region" aria-label="Pending request" data-testid="gate-collapsed">
          <Button
            variant="ghost"
            size="md"
            ref={expandButton}
            type="button"
            onClick={(event) => setCollapsed(false, event)}
            aria-expanded={false}
            aria-describedby={[
              error ? `gate-${gate.id}-hint` : null,
              gate.expiresAt !== undefined ? `gate-${gate.id}-expiry` : null,
            ].filter(Boolean).join(" ") || undefined}
            aria-controls={`gate-${gate.id}-card`}
            className="flex w-full min-w-0 justify-start gap-2 rounded-md px-5 text-left max-sm:gap-1.5 max-sm:px-4 focus-visible:ring-inset focus-visible:ring-offset-0"
          >
            {error ? <StatusDot tone="danger" /> : <StatusDot tone={expired ? "neutral" : "warning"} pulse={!expired} />}
            <Badge variant={kind.variant} className={error || gate.expiresAt !== undefined ? "max-sm:hidden" : undefined}>{kind.label}</Badge>
            {(error || gate.expiresAt !== undefined) && <span className="sr-only sm:hidden">{kind.label}</span>}
            {error && <span className="flex-none text-xs font-medium text-danger-600 sm:max-w-[50%] sm:truncate">
              <span className="sm:hidden">{attachmentRejected ? "Rejected" : "Failed"}</span>
              <span className="hidden sm:inline">{attachmentRejected ? "Attachment rejected" : "Failed"}</span>
            </span>}
            <span title={gate.title} className="min-w-0 flex-1 truncate text-sm font-medium text-ink">{gate.title}</span>
            {gate.expiresAt !== undefined && <span aria-hidden className="w-12 shrink-0 sm:w-24" />}
            <ChevronUp aria-hidden className="h-4 w-4 shrink-0" />
          </Button>
          {gate.expiresAt !== undefined && <ExpiryCountdown expiresAt={gate.expiresAt} onExpiredChange={setExpired} compactBelowSm descriptionId={`gate-${gate.id}-expiry`} className="pointer-events-none absolute right-10 top-1/2 -translate-y-1/2 whitespace-nowrap sm:right-11" />}
          {error && <span id={`gate-${gate.id}-hint`} hidden>{attachmentRejected ? "Expand to fix attachment" : "Expand to retry"}</span>}
        </div>
      </div>
    );
  }

  // A known tool call shows as a preview. Its raw tool_id/args block moves
  // behind Details.
  const preview = gate.tool && hasGatePayloadPreview(gate.tool) ? gate.tool : undefined;
  const parts = preview && gate.body ? splitGateBody(gate.body) : undefined;

  return (
    <div className={columnClass}>
      <div
        id={`gate-${gate.id}-card`}
        className={surfaceClass}
        role="dialog"
        aria-live="polite"
        aria-busy={busy}
        aria-describedby={gate.body ? `gate-${gate.id}-body` : undefined}
        aria-labelledby={`gate-${gate.id}-title`}
      >
        {/* The icon sits beside the badge, so the title, body, and controls
            all start at the card's padding edge. */}
        <header className={cn(inset, "flex items-start gap-2.5 pt-3 pb-2")}>
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2">
              <Icon aria-hidden className="h-4 w-4 shrink-0 text-muted" />
              {inNotification
                ? <span className="text-xs font-medium text-muted">{kind.label}</span>
                : <Badge variant={kind.variant}>{kind.label}</Badge>}
              {gate.expiresAt !== undefined && <ExpiryCountdown expiresAt={gate.expiresAt} className="ml-auto" />}
            </div>
            <DecisionGateTitle key={`${gate.id}:${gate.title}`} id={`gate-${gate.id}-title`} title={gate.title} />
          </div>
          {collapsible && (
            <Button ref={collapseButton} variant="ghost" size="icon" onClick={(event) => setCollapsed(true, event)} disabled={busy} aria-label="Collapse request" aria-expanded={true} aria-controls={`gate-${gate.id}-card`}>
              <ChevronDown aria-hidden className="h-3.5 w-3.5" />
            </Button>
          )}
          <Button variant="ghost" size="icon" onClick={cancel} disabled={busy} aria-label="Cancel and dismiss" className="-mr-1">
            <X aria-hidden className="h-3.5 w-3.5" />
          </Button>
        </header>

        {error && <p role="alert" className={cn(inset, "py-2 break-words text-sm text-danger-600")}>{error} Try again.</p>}

        {gate.body && (
          <div
            id={`gate-${gate.id}-body`}
            role="region"
            tabIndex={0}
            aria-label="Request details"
            className={cn(inset, "max-h-[min(14rem,25dvh)] overflow-y-auto pb-3 text-sm leading-relaxed text-muted break-words [overflow-wrap:anywhere]", preview ? "space-y-2" : "whitespace-pre-wrap")}
          >
            {preview ? (
              <>
                {parts?.summary && <p className="whitespace-pre-wrap">{parts.summary}</p>}
                <GatePayloadPreview tool={preview} />
                {parts?.call && (
                  <details>
                    <summary className="min-h-11 cursor-pointer select-none py-3 text-xs font-medium text-ink sm:min-h-0 sm:py-0">Details</summary>
                    <pre className="mt-1.5 whitespace-pre-wrap rounded bg-ink-wash p-2 font-mono text-xs [overflow-wrap:anywhere]">{parts.call}</pre>
                  </details>
                )}
              </>
            ) : gate.body}
          </div>
        )}

        {gate.agentReason && <div className={cn(inset, "pb-3 text-sm text-muted whitespace-pre-wrap break-words")}>
          <p className="font-medium">Agent's stated reason</p>
          <p className="text-xs">Model-authored text. Verify it before you approve.</p>
          <blockquote>{gate.agentReason}</blockquote>
        </div>}

        {gate.provenance && provenanceLine(gate.provenance) && (
          <div className={cn(inset, "pb-2 text-xs text-muted")} data-testid="gate-provenance">
            {provenanceLine(gate.provenance)}
          </div>
        )}

        {busy && <p role="status" className={cn(inset, "pb-2 text-xs text-muted")}>{reading ? "Reading images…" : withdraw.isPending ? "Dismissing request…" : "Sending response…"}</p>}

        {gate.type === "question" ? (
          <>
          {gate.actions.length > 0 && (
            <div className={cn(inset, "pb-2 flex flex-wrap gap-2")}>
              {gate.actions.map((a) => (
                <Button key={a.id} variant="secondary" size="sm" className={WRAPPING_BUTTON} onClick={() => pickAction(a.id)} disabled={busy}>
                  <span className="min-w-0 [overflow-wrap:anywhere]">{a.label}</span>
                </Button>
              ))}
            </div>
          )}
          <div className={cn(inset, "pb-3")}
            onDragOver={(event) => { if (event.dataTransfer.types.includes("Files")) { event.preventDefault(); event.stopPropagation(); } }}
            onDrop={(event) => { if (event.dataTransfer.files.length) { event.preventDefault(); event.stopPropagation(); void addImages(Array.from(event.dataTransfer.files)); } }}>
            <ComposerImageStrip images={images} onRemove={(id) => { if (!busy) setImages((current) => current.filter((image) => image.id !== id)); }} />
            <input ref={picker} type="file" accept={IMAGE_ACCEPT_ATTRIBUTE} multiple className="sr-only" aria-label="Attach images to answer" disabled={busy}
              onChange={(event) => { void addImages(Array.from(event.target.files ?? [])); event.target.value = ""; }} />
            {/* The answer field spans the card, so it lines up with the title and
                the options above it. Attach and Submit sit on the row below, as in
                the message box. */}
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
              className="w-full"
              disabled={busy}
            />
            <div className="mt-2 flex items-center justify-between gap-2">
              <Button variant="ghost" size="icon" aria-label="Attach images" disabled={busy} onClick={() => picker.current?.click()} className="-ml-2">
                <Paperclip className="h-4 w-4" />
              </Button>
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
          <div className={cn(inset, "flex flex-wrap items-center gap-2", inNotification ? "justify-start pb-4 pt-1" : "justify-end pb-3")}>
            {canHide && (
              <Button ref={notNowButton} variant="ghost" size="sm" onClick={(event) => setHidden(true, event)} disabled={busy}>
                Not now
              </Button>
            )}
            {gate.actions.map((a) => {
              const isAlwaysAllow = a.id === GATE_ACTION_ALWAYS_ALLOW;
              const disabled = busy || (isAlwaysAllow && !isAdmin);
              const button = (
                <Button
                  key={a.id}
                  size="sm"
                  className={WRAPPING_BUTTON}
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
                  <span className="min-w-0 [overflow-wrap:anywhere]">{a.label}</span>
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
function provenanceLine(p: NonNullable<DecisionGate["provenance"]>): string | null {
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
    // The title already says the call would use this person's shared
    // account, and the body says only they can answer.
    case "shared_account":
      return null;
    default:
      // An unknown source is an internal id, not something to show people.
      return "Gated by policy.";
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
