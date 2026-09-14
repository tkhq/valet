import type { AgentTool, AgentToolResult } from "@earendil-works/pi-agent-core";
import type { TextContent, ImageContent } from "@earendil-works/pi-ai/compat";
import type { BuiltinPolicyResolveInput, PolicyDecision, ToolDef, ToolContext, ToolResult, ToolAttachment } from "./types.js";
import { attrTruncate, withSpan } from "./tracing.js";
import { recordToolExecution } from "./metrics.js";
import { redactCanonicalValue } from "./authorization/redaction.js";
import { BuiltinAuthorizationError } from "./errors.js";
import { projectBuiltinArguments } from "./authorization/builtin-tools.js";

/**
 * Adapt one engine ToolDef to a pi-agent-core AgentTool, capturing the engine
 * ToolContext via closure. The bridge also normalizes our ToolResult into the
 * pi AgentToolResult shape (TextContent | ImageContent[]).
 *
 * `buildContext` receives the toolCallId, toolName, and validated args so the
 * engine can persist them in SuspendedTurnState if the tool opens a gate.
 */
export function toAgentTool<TParams extends import("typebox").TSchema>(
  def: ToolDef<TParams>,
  buildContext: (args: {
    signal: AbortSignal;
    toolCallId: string;
    toolName: string;
    toolArgs: Record<string, unknown>;
  }) => ToolContext,
): AgentTool<TParams> {
  return {
    name: def.name,
    label: def.name,
    description: def.description,
    parameters: def.parameters,
    // Sequential unless the tool opts in (TKAI-318). One sequential tool
    // serializes its whole batch in pi-agent-core, so a response mixing a
    // read with a write runs fully in model order — mutations never race
    // and approval gates surface in execution order. An exclusive tool is forced sequential even when marked concurrencySafe.
    // Exclusivity controls dispatch order only; canonical policy controls approval.
    executionMode:
      def.concurrencySafe && !def.exclusiveDispatch ? "parallel" : "sequential",
    execute: async (toolCallId, params, signal) => {
      const ctx = buildContext({
        signal: signal ?? new AbortController().signal,
        toolCallId,
        toolName: def.name,
        toolArgs: params as Record<string, unknown>,
      });
      // Every engine tool call funnels through this bridge — one span per
      // execution, a child of the running agent.turn via the active context.
      // A decision-gate suspension throws out of execute; the span ends with
      // error status, which doubles as the suspension marker in the trace.
      // Sizes, not content: args/result text can be huge and/or sensitive.
      // `path` is the one arg surfaced verbatim — file tools all take it and
      // it is the highest-value single attribute when debugging a tool call.
      const argsRecord = params as Record<string, unknown>;
      const path = typeof argsRecord.path === "string" ? argsRecord.path : undefined;
      return withSpan(
        `tool.${def.name}`,
        {
          "valet.tool.name": def.name,
          "valet.tool.call_id": toolCallId,
          "valet.tool.args_chars": JSON.stringify(params ?? {}).length,
          ...(path !== undefined ? { "valet.tool.path": attrTruncate(path) } : {}),
        },
        async (span) => {
          const startedAt = Date.now();
          try {
            const result = await executeAuthorizedBuiltin(def, params as never, ctx, toolCallId);
            recordToolExecution(def.name, Date.now() - startedAt, true);
            span.setAttribute("valet.tool.result_chars", result.text?.length ?? 0);
            if (result.attachments?.length) {
              span.setAttribute("valet.tool.attachments", result.attachments.length);
            }
            return toAgentToolResult(result, def.name);
          } catch (err) {
            recordToolExecution(def.name, Date.now() - startedAt, false);
            span.setAttribute(
              "valet.tool.error",
              attrTruncate(err instanceof Error ? err.message : String(err), 300),
            );
            throw err;
          }
        },
      );
    },
  };
}

const INDETERMINATE_BUILTIN = "indeterminate_execution: the tool may have run. Do not retry automatically.";

async function executeAuthorizedBuiltin<TParams extends import("typebox").TSchema>(def: ToolDef<TParams>, params: import("typebox").Static<TParams>, ctx: ToolContext, toolCallId: string): Promise<ToolResult> {
  const resolver = ctx.builtinPolicyResolver;
  if (!resolver) return def.execute(params, ctx);
  if (!def.authorization || !ctx.queueItemId || !ctx.owner) return { text: "[builtin_authorization_missing] This tool is unavailable because its canonical authorization metadata or invocation identity is incomplete. Ask an administrator to correct the tool registration.", ok: false };
  let input: BuiltinPolicyResolveInput = { descriptor: def.authorization, args: params as Record<string, unknown>, userId: ctx.userId, orgId: ctx.orgId, sessionId: ctx.sessionId, threadId: ctx.threadId, owner: ctx.owner, queueItemId: ctx.queueItemId, toolCallId, gateOrdinal: ctx.suspendedDecision?.ordinal ?? 0 };
  let decision: PolicyDecision;
  try { decision = await resolver.resolve(input); } catch { return denied("fail_closed.service_error"); }
  if (decision.mode === "deny") { emitBuiltinInvocation(resolver, input, decision, "denied"); return denied(decision.canonical?.reasonCode ?? "policy_denied"); }
  if (decision.mode === "require_approval") {
    if (def.authorization.actionId === "builtin.ask_approval") throw new BuiltinAuthorizationError("recursive_approval");
    const canonical = decision.canonical;
    if (!canonical?.approvalRequirement) return denied("fail_closed.invalid_approval");
    const resolution = await ctx.requestDecision({ type: "approval", title: `Approve ${def.name}?`, body: `Canonical policy requires ${canonical.approvalRequirement.tier} approval.`, resumeKey: `builtin:${canonical.requestSubjectDigest}:${canonical.decisionDigest}`, context: { authorization: { actionId: def.authorization.actionId, ...canonical } } });
    if (resolution.actionId !== "approve") return { text: `denied: user did not approve ${def.name}. This denial is final for the current turn. Do not retry automatically.`, ok: false };
    try { await resolver.onResolution?.(input, decision, resolution); } catch { return denied("fail_closed.approval_persistence"); }
    input = { ...input, gateOrdinal: resolution.gateOrdinal ?? input.gateOrdinal };
    try { decision = await resolver.resolve(input); } catch { return denied("fail_closed.service_error"); }
    if (decision.mode !== "allow") return denied(decision.canonical?.reasonCode ?? "approval_re_evaluation_denied");
  }
  enforceBuiltinObligations(decision, input, resolver);
  let attemptId: string | undefined;
  if (resolver.reserveExecution) {
    const reservation = await resolver.reserveExecution(input, decision);
    if (reservation.kind === "completed") { emitBuiltinInvocation(resolver, input, decision, "completed", reservation.result); return reservation.result; }
    if (reservation.kind === "failed") { emitBuiltinInvocation(resolver, input, decision, "error", reservation.result, reservation.error); return reservation.result ?? { text: reservation.error, ok: false }; }
    if (reservation.kind === "indeterminate") return { text: reservation.error, ok: false };
    attemptId = reservation.attemptId;
  }
  let raw: ToolResult;
  try { raw = await def.execute(params, ctx); }
  catch {
    if (attemptId && resolver.completeExecution) {
      try { const settlement = await resolver.completeExecution(input, decision, attemptId, { outcome: "failed", error: "Tool execution failed." }); return { text: settlement.outcome === "failed" ? settlement.error : INDETERMINATE_BUILTIN, ok: false }; }
      catch { return { text: INDETERMINATE_BUILTIN, ok: false }; }
    }
    return { text: "Tool execution failed.", ok: false };
  }
  const live = redactCanonicalValue(raw, decision.canonical?.redactions.filter((item) => item.target === "user_output") ?? []);
  if (attemptId && resolver.completeExecution) {
    const stored = redactCanonicalValue(raw, decision.canonical?.redactions.filter((item) => item.target === "audit") ?? []);
    try {
      const settlement = await resolver.completeExecution(input, decision, attemptId, { outcome: "completed", result: stored });
      if (settlement.outcome === "failed" && settlement.error.startsWith("indeterminate_execution:")) return { text: settlement.error, ok: false };
    } catch { return { text: INDETERMINATE_BUILTIN, ok: false }; }
  }
  emitBuiltinInvocation(resolver, input, decision, "completed", { text: "", code: "completed_output_unavailable", ok: false });
  return live;
}

function emitBuiltinInvocation(resolver: NonNullable<ToolContext["builtinPolicyResolver"]>, input: BuiltinPolicyResolveInput, decision: PolicyDecision, status: "completed" | "denied" | "error", result?: ToolResult, error?: string): void {
  if (!resolver.onInvocation) return;
  const record = { toolId: input.descriptor.actionId, service: "builtin", actionId: input.descriptor.actionId, riskLevel: input.descriptor.riskLevel, sessionId: input.sessionId, threadId: input.threadId, userId: input.userId, orgId: input.orgId, appliesIn: "session" as const, status, resolvedMode: decision.mode, provenance: decision.provenance, resumeKey: `${input.queueItemId}:${input.toolCallId}`, queueItemId: input.queueItemId, gateOrdinal: input.gateOrdinal, params: projectBuiltinArguments(input.args, input.descriptor.projection.pointers), ...(result === undefined ? {} : { result }), ...(error === undefined ? {} : { error }) };
  try { void Promise.resolve(resolver.onInvocation(record)).catch(() => {}); } catch { /* Replay repairs a synchronous audit failure. */ }
}

function denied(reason: string): ToolResult { return { text: `denied by canonical built-in policy (${reason}). Do not retry automatically.`, ok: false }; }
function enforceBuiltinObligations(decision: PolicyDecision, input: BuiltinPolicyResolveInput, resolver: NonNullable<ToolContext["builtinPolicyResolver"]>): void {
  for (const obligation of decision.canonical?.obligations ?? []) {
    if (obligation.type === "target_idempotency" && (!input.queueItemId || !resolver.reserveExecution || !resolver.completeExecution)) throw new Error("Canonical built-in idempotency obligation failed.");
    else if (obligation.type === "sandbox_capabilities") {
      if (obligation.capabilities.some((capability) => capability !== input.descriptor.capability)) throw new Error("Canonical built-in capability obligation failed.");
    } else throw new Error("Canonical built-in obligation is unsupported.");
  }
}
function toAgentToolResult(result: ToolResult, toolName: string): AgentToolResult<unknown> {
  const content: (TextContent | ImageContent)[] = [];
  if (result.text) content.push({ type: "text", text: result.text });
  for (const att of result.attachments ?? []) {
    const block = attachmentToContent(att);
    if (block) content.push(block);
  }
  // Never send an EMPTY tool result: at the prompt tail it can make the
  // model end its turn with zero output (TKAI-318, from Claude Code).
  if (content.length === 0) {
    content.push({ type: "text", text: `(${toolName} completed with no output)` });
  }
  // The action-level outcome rides in details so it survives persistence:
  // the channel host reads part.result.details.ok to tell a successful
  // reply_to_origin from a completed-but-failed one.
  return { content, details: result.ok === undefined && result.code === undefined ? undefined : { ...(result.ok === undefined ? {} : { ok: result.ok }), ...(result.code === undefined ? {} : { code: result.code }) } };
}

function attachmentToContent(att: ToolAttachment): TextContent | ImageContent | null {
  if (att.type === "image") {
    return {
      type: "image",
      data: bytesToBase64(att.data),
      mimeType: att.mimeType,
    };
  }
  if (att.type === "text") {
    const lang = att.language ? ` (${att.language})` : "";
    return { type: "text", text: `--- ${att.name ?? "attachment"}${lang} ---\n${att.content}` };
  }
  // file: omit raw bytes from LLM context — engine should have stored via BlobStore
  return { type: "text", text: `[file attachment: ${att.name}]` };
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  // Use globalThis.btoa to avoid Node's deprecated Buffer; available in Node 16+ and browsers.
  return (globalThis as { btoa: (s: string) => string }).btoa(binary);
}
