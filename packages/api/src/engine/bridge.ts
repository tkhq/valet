import type {
  CommandResultEntry,
  DeliveredBusEvent,
  DecisionGate as EngineDecisionGate,
  DecisionResolution as EngineDecisionResolution,
  MessageEntry as EngineMessageEntry,
  MessagePart as EngineMessagePart,
  QueueState as EngineQueueState,
} from "@valet/engine";
import type {
  DecisionGate as WireDecisionGate,
  DecisionGateProvenance,
  DecisionResolution as WireDecisionResolution,
  Message,
  MessagePart as WireMessagePart,
  MessageSignal as WireMessageSignal,
  WireEvent,
} from "../wire/types.js";

/**
 * Project an engine DecisionGate to its wire shape. Drops engine-only fields
 * (origin/refs, and `context` as a whole — surfacing the raw bag would
 * commit us to a contract before we know what we want). The ONE typed
 * extraction is `context.provenance` (policy gates, action-policies spec
 * decision 4): the wire carries a validated `DecisionGateProvenance` so gate
 * surfaces can render WHY the gate opened.
 */
export function engineGateToWire(g: EngineDecisionGate): WireDecisionGate {
  const provenance = gateProvenance(g.context);
  return {
    id: g.id,
    sessionId: g.sessionId,
    threadId: g.threadId,
    type: g.type,
    title: g.title,
    body: g.body,
    actions: g.actions,
    expiresAt: g.expiresAt,
    status: g.status,
    createdAt: g.createdAt,
    updatedAt: g.updatedAt,
    ...(provenance ? { provenance } : {}),
  };
}

const WIRE_APPROVAL_MODES: ReadonlySet<string> = new Set(["allow", "require_approval", "deny"]);

/** Narrow the engine gate's untyped `context.provenance` into the wire's
 * `DecisionGateProvenance`. Fail-soft: any shape surprise → undefined (the
 * gate still renders, just without the "why" line). */
function gateProvenance(context: Record<string, unknown> | undefined): DecisionGateProvenance | undefined {
  const p = context?.provenance;
  if (p === null || p === undefined || typeof p !== "object") return undefined;
  const prov = p as Record<string, unknown>;
  const { baseMode, source } = prov;
  if (typeof baseMode !== "string" || !WIRE_APPROVAL_MODES.has(baseMode) || typeof source !== "string") {
    return undefined;
  }
  return {
    // Narrowed by the WIRE_APPROVAL_MODES membership check above.
    baseMode: baseMode as DecisionGateProvenance["baseMode"],
    source,
    ...(typeof prov.matchedPolicyId === "string" ? { matchedPolicyId: prov.matchedPolicyId } : {}),
    ...(typeof prov.matchedGrantId === "string" ? { matchedGrantId: prov.matchedGrantId } : {}),
    ...(typeof prov.matchedOverrideId === "string" ? { matchedOverrideId: prov.matchedOverrideId } : {}),
  };
}

export function engineResolutionToWire(r: EngineDecisionResolution): WireDecisionResolution {
  return {
    actionId: r.actionId,
    value: r.value,
    resolvedBy: r.resolvedBy,
    resolvedAt: r.resolvedAt,
  };
}

/**
 * Translate engine MessagePart → wire MessagePart.
 *
 * Engine has more variants than the wire (attachment, error — still
 * dropped; the UI doesn't render them). `thinking` is forwarded as-is.
 */
export function engineToWireParts(parts?: EngineMessagePart[]): WireMessagePart[] {
  if (!parts) return [];
  const out: WireMessagePart[] = [];
  for (const p of parts) {
    switch (p.type) {
      case "text":
        out.push({ kind: "text", text: p.text });
        break;
      case "tool_call":
        out.push({
          kind: "tool_call",
          callId: p.callId,
          toolName: p.toolName,
          status: p.status,
          args: p.args,
          result: p.result,
          error: p.error,
        });
        break;
      case "thinking":
        out.push({ kind: "thinking", text: p.text });
        break;
      // attachment, error parts: dropped on the wire (UI ignores).
      case "attachment":
      case "error":
        break;
    }
  }
  return out;
}

/**
 * Trim an engine `MessageEntry.signal` to the wire shape (plan decision 2).
 *
 * `tagName`/`hopCount`/`senderOwner` are engine-internal (XML envelope
 * rendering, hop-budget enforcement, ACL bookkeeping) — the UI only needs
 * `signalType`/`attributes`/`senderSessionId` to render a signal card.
 */
export function engineSignalToWire(
  signal: EngineMessageEntry["signal"],
): WireMessageSignal | undefined {
  if (!signal) return undefined;
  return {
    signalType: signal.signalType,
    attributes: signal.attributes,
    senderSessionId: signal.senderSessionId,
  };
}

/**
 * Project a `CommandResultEntry` to its wire `Message` shape.
 *
 * Called from BOTH `busEventToWire` (live WS path) and `entryToMessage`
 * (REST reload path) so the two shapes are always identical. Shape drift here
 * is the documented three-time regression (CLAUDE.md "Tool-call persistence
 * round trip").
 */
export function commandResultEntryToMessage(
  e: CommandResultEntry,
  sessionId: string,
  threadId: string,
): Message {
  const created = e.createdAt;
  return {
    id: e.id,
    sessionId,
    threadId,
    role: "system",
    content: e.output,
    parts: [],
    createdAt: Number.isFinite(created) ? created : Date.now(),
    queueItemId: e.queueItemId,
    command: {
      // Strip the leading slash from the stored command string.
      name: e.command.startsWith("/") ? e.command.slice(1) : e.command,
      source: e.source,
      ok: e.ok,
    },
  };
}

/**
 * Map an engine BusEvent to zero or more wire events.
 *
 * The bridge is mechanical: each engine event type either translates 1:1, is
 * dropped, or produces a small ordered fan-out of wire events. Sequence
 * numbers and timestamps are added by the WebSocket dispatcher (`emitter()`)
 * — this function returns `Omit<WireEvent, "seq" | "ts">[]` so the dispatcher
 * stays the source of truth for ordering.
 */
/**
 * Distributive `Omit` so the discriminated union survives the narrowing.
 * Plain `Omit<WireEvent, ...>` collapses to a single intersection type;
 * `WireEvent extends infer T ? ...` distributes per variant.
 */
export type WireEventDraft = WireEvent extends infer T
  ? T extends WireEvent
    ? Omit<T, "seq" | "ts">
    : never
  : never;

/**
 * Project the engine's full QueueState to a `queue.state` frame with id
 * lists — the live socket stays thin; the admin surface returns full items.
 * Shared by the bus-event path below and the WS handshake, which seeds one
 * frame per thread so a client connecting mid-turn sees the queue without
 * waiting for the next transition.
 */
export function queueStateToWire(
  sessionId: string,
  threadId: string,
  state: EngineQueueState,
): WireEventDraft {
  return {
    type: "queue.state",
    sessionId,
    threadId,
    state: {
      mode: state.mode,
      status: state.status,
      activeItemId: state.activeItemId,
      pendingIds: state.pending.map((i) => i.id),
      collectingIds: (state.collectBuffer ?? []).map((i) => i.id),
      blockedGateId: state.blockedGateId,
    },
  };
}

export function busEventToWire(ev: DeliveredBusEvent): WireEventDraft[] {
  const e = ev.event;
  switch (e.type) {
    case "message_start":
      return [
        {
          type: "message_start",
          threadId: e.threadId,
          messageId: e.messageId,
          role: e.role === "system" ? "system" : "assistant",
        },
      ];

    case "text_delta":
      // Wire delta carries messageId so the client can target the right row.
      // Engine's text_delta doesn't ship messageId; the client correlates by
      // the most recent message_start. We forward the delta verbatim and let
      // the consumer track the active messageId for that thread.
      return [
        {
          type: "text_delta",
          threadId: e.threadId,
          messageId: "", // filled in by dispatcher's per-thread state
          delta: e.text,
        },
      ];

    case "message_update":
      return [
        {
          type: "message_update",
          threadId: e.threadId,
          messageId: e.messageId,
          parts: engineToWireParts(e.parts),
          content: e.content,
        },
      ];

    case "message_end":
      return [
        {
          type: "message_end",
          threadId: e.threadId,
          messageId: e.messageId,
          reason: e.reason,
        },
      ];

    case "tool_call_update":
      return [
        {
          type: "tool_call_update",
          threadId: e.threadId,
          callId: e.callId,
          toolName: e.toolName,
          argsDelta: e.argsDelta,
        },
      ];

    case "tool_start":
      return [
        {
          type: "tool_start",
          threadId: e.threadId,
          toolName: e.tool,
          callId: e.callId,
          args: e.args,
        },
      ];

    case "tool_end":
      return [
        {
          type: "tool_end",
          threadId: e.threadId,
          toolName: e.tool,
          callId: e.callId,
          result: e.result,
          isError: e.isError,
        },
      ];

    case "status":
      return [
        {
          type: "status",
          threadId: e.threadId,
          status: e.status,
        },
      ];

    case "turn_end":
      return [
        {
          type: "turn_end",
          threadId: e.threadId,
          reason: e.reason,
        },
      ];

    case "error":
      return [
        {
          type: "error",
          threadId: e.threadId,
          code: e.code,
          message: e.error,
          recoverable: e.recoverable,
        },
      ];

    case "model_switched":
      return [
        {
          type: "model_switched",
          // Engine may emit threadId as an empty string for session-scope
          // switches; normalize to undefined so the client can detect
          // "session vs thread scope" cleanly.
          threadId: e.threadId || undefined,
          fromModel: e.fromModel,
          toModel: e.toModel,
          reason: e.reason,
        },
      ];

    case "decision_gate":
      return [
        {
          type: "decision_gate",
          threadId: e.threadId,
          gate: engineGateToWire(e.gate),
        },
      ];

    case "decision_gate_resolved":
      return [
        {
          type: "decision_gate_resolved",
          threadId: e.threadId,
          gateId: e.gateId,
          resolution: engineResolutionToWire(e.resolution),
        },
      ];

    case "decision_gate_expired":
      return [
        {
          type: "decision_gate_expired",
          threadId: e.threadId,
          gateId: e.gateId,
        },
      ];

    case "decision_gate_withdrawn":
      return [
        {
          type: "decision_gate_withdrawn",
          threadId: e.threadId,
          gateId: e.gateId,
          reason: e.reason,
        },
      ];

    case "queue_state":
      // sessionId comes from the envelope (the engine event only carries
      // threadId + state).
      return [queueStateToWire(ev.sessionId, e.threadId, e.state)];

    case "submission_settled":
      return [
        {
          type: "submission.settled",
          sessionId: e.sessionId,
          threadId: e.threadId,
          queueItemId: e.queueItemId,
          outcome: e.outcome.outcome,
          error: e.outcome.error,
        },
      ];

    case "command_result":
      return [
        {
          type: "command_result",
          threadId: e.threadId || undefined,
          message: commandResultEntryToMessage(
            e.entry,
            ev.sessionId,
            e.threadId ?? "",
          ),
        },
      ];

    // Out of agent-loop v1 scope — silently dropped. Future plans:
    // compaction events, child-task events, thread lifecycle.
    case "thread_start":
    case "compaction_start":
    case "compaction_end":
    case "task_start":
    case "task_end":
    // submission_stuck is an attention signal routed in Phase 4; no wire mapping yet.
    case "submission_stuck":
      return [];

    case "sandbox_status":
      return [
        {
          type: "sandbox.status",
          state: e.state,
          epoch: e.epoch,
          estimateMs: e.estimateMs,
        },
      ];
  }
}
