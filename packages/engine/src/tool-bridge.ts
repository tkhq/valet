import type { AgentTool, AgentToolResult } from "@earendil-works/pi-agent-core";
import type { TextContent, ImageContent } from "@earendil-works/pi-ai/compat";
import type { BuiltinPolicyResolveInput, PolicyDecision, ToolDef, ToolContext, ToolResult, ToolAttachment } from "./types.js";
import { attrTruncate, withSpan } from "./tracing.js";
import { recordToolExecution } from "./metrics.js";
import { redactCanonicalValue } from "./authorization/redaction.js";
import { BuiltinAuthorizationError } from "./errors.js";
import { isDecisionGateExpired } from "./decision-gate.js";
import { builtinApprovalDisplay, builtinIntentDigest, projectBuiltinArguments } from "./authorization/builtin-tools.js";

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
  const fallback = (reason: string): PolicyDecision => ({ mode: "deny", provenance: { baseMode: "deny", source: "resolver_error" }, canonical: { reasonCode: reason, obligations: [], redactions: [], requestId: "unavailable", requestSubjectDigest: "0".repeat(64), inputDigest: "0".repeat(64), policyDigest: "0".repeat(64), sourceBundleDigest: "0".repeat(64), evaluatorKind: "local_valet", engineDigest: "0".repeat(64), decisionDigest: "0".repeat(64) } });
  let decision: PolicyDecision;
  try { decision = await resolver.resolve(input); } catch { decision = fallback("fail_closed.service_error"); await emitBuiltinInvocation(resolver, input, decision, "denied", undefined, decision.canonical?.reasonCode); return denied(decision.canonical!.reasonCode); }
  if (decision.mode === "deny") { await emitBuiltinInvocation(resolver, input, decision, "denied"); return denied(decision.canonical?.reasonCode ?? "policy_denied"); }
  if (decision.mode === "require_approval") {
    if (def.authorization.actionId === "builtin.ask_approval") { await emitBuiltinInvocation(resolver, input, decision, "rejected", undefined, "recursive_approval"); throw new BuiltinAuthorizationError("recursive_approval"); }
    const canonical = decision.canonical;
    if (!canonical?.approvalRequirement) { await emitBuiltinInvocation(resolver, input, decision, "denied", undefined, "fail_closed.invalid_approval"); return denied("fail_closed.invalid_approval"); }
    const intent = builtinIntentDigest({ descriptor: def.authorization, arguments: params, organizationId: ctx.orgId, actorId: ctx.userId, owner: ctx.owner, sessionId: ctx.sessionId, threadId: ctx.threadId });
    const display = builtinApprovalDisplay(def.name, params);
    let resolution: import("./types.js").DecisionResolution;
    try {
      resolution = await ctx.requestDecision({ type: "approval", title: `Approve ${def.name}?`, body: `Canonical policy requires ${canonical.approvalRequirement.tier} approval.`, resumeKey: `builtin:${intent}`, dedupeKey: `builtin:${intent}`, context: { tool_id: def.authorization.actionId, service: "builtin", riskLevel: def.authorization.riskLevel, args: display, summary: `Canonical policy requires ${canonical.approvalRequirement.tier} approval.` } });
    } catch (error) {
      if (!isDecisionGateExpired(error)) throw error;
      input = { ...input, gateOrdinal: error.ordinal ?? input.gateOrdinal };
      await emitBuiltinInvocation(resolver, input, decision, "error", undefined, "approval_expired");
      return { text: `approval request expired for ${def.name}. Do not retry automatically in this turn.`, ok: false };
    }
    input = { ...input, gateOrdinal: resolution.gateOrdinal ?? input.gateOrdinal };
    if (resolution.actionId !== "approve") { await emitBuiltinInvocation(resolver, input, decision, "rejected"); return { text: `denied: user did not approve ${def.name}. This denial is final for the current turn. Do not retry automatically.`, ok: false }; }
    try { await resolver.onResolution?.(input, decision, resolution); } catch { await emitBuiltinInvocation(resolver, input, decision, "error", undefined, "approval_persistence_failed"); return denied("fail_closed.approval_persistence"); }
    try { decision = await resolver.resolve(input); } catch { decision = fallback("fail_closed.service_error"); await emitBuiltinInvocation(resolver, input, decision, "denied"); return denied(decision.canonical!.reasonCode); }
    if (decision.mode !== "allow") { await emitBuiltinInvocation(resolver, input, decision, "denied"); return denied(decision.canonical?.reasonCode ?? "approval_re_evaluation_denied"); }
  }
  try { enforceBuiltinObligations(decision, input, resolver); } catch { await emitBuiltinInvocation(resolver, input, decision, "denied", undefined, "obligation_failed"); return denied("fail_closed.obligation"); }
  let attemptId: string | undefined;
  try {
    if (resolver.reserveExecution) {
      const reservation = await resolver.reserveExecution(input, decision);
      if (reservation.kind === "completed") { await emitBuiltinInvocation(resolver, input, decision, "completed", reservation.result); return reservation.result; }
      if (reservation.kind === "failed") { await emitBuiltinInvocation(resolver, input, decision, "error", reservation.result, reservation.error); return reservation.result ?? { text: reservation.error, ok: false }; }
      if (reservation.kind === "indeterminate") { await emitBuiltinInvocation(resolver, input, decision, "error", undefined, reservation.error); return { text: reservation.error, ok: false }; }
      attemptId = reservation.attemptId;
    }
  } catch { await emitBuiltinInvocation(resolver, input, decision, "error", undefined, "execution_reservation_failed"); return denied("fail_closed.audit_reservation"); }
  let raw: ToolResult;
  try { raw = await def.execute(params, ctx); }
  catch {
    const error = "Tool execution failed.";
    if (attemptId && resolver.completeExecution) { try { await resolver.completeExecution(input, decision, attemptId, { outcome: "failed", error }); } catch { return { text: INDETERMINATE_BUILTIN, ok: false }; } }
    await emitBuiltinInvocation(resolver, input, decision, "error", undefined, error);
    return { text: error, ok: false };
  }
  try {
    const userResult = redactCanonicalValue(raw, decision.canonical?.redactions.filter((item) => item.target === "user_output") ?? []);
    const auditResult = redactCanonicalValue(raw, decision.canonical?.redactions.filter((item) => item.target === "audit") ?? []);
    const handledFailure = raw.ok === false;
    if (attemptId && resolver.completeExecution) await resolver.completeExecution(input, decision, attemptId, handledFailure ? { outcome: "failed", error: "Tool returned a handled failure.", result: auditResult } : { outcome: "completed", result: auditResult });
    await emitBuiltinInvocation(resolver, input, decision, handledFailure ? "error" : "completed", { text: "", code: "completed_output_unavailable", ok: !handledFailure }, handledFailure ? "Tool returned a handled failure." : undefined);
    return userResult;
  } catch {
    if (attemptId && resolver.completeExecution) { try { await resolver.completeExecution(input, decision, attemptId, { outcome: "failed", error: "Post-execution policy processing failed." }); } catch { return { text: INDETERMINATE_BUILTIN, ok: false }; } }
    return { text: INDETERMINATE_BUILTIN, ok: false };
  }
}

async function emitBuiltinInvocation(resolver: NonNullable<ToolContext["builtinPolicyResolver"]>, input: BuiltinPolicyResolveInput, decision: PolicyDecision, status: "completed" | "denied" | "rejected" | "error", result?: ToolResult, error?: string): Promise<void> {
  if (!resolver.onInvocation) return;
  const resumeKey = builtinIntentDigest({ descriptor: input.descriptor, arguments: input.args, organizationId: input.orgId, actorId: input.userId, owner: input.owner, sessionId: input.sessionId, threadId: input.threadId });
  await resolver.onInvocation({ toolId: input.descriptor.actionId, service: "builtin", actionId: input.descriptor.actionId, riskLevel: input.descriptor.riskLevel, sessionId: input.sessionId, threadId: input.threadId, userId: input.userId, orgId: input.orgId, appliesIn: "session", status, resolvedMode: decision.mode, provenance: decision.provenance, resumeKey, queueItemId: input.queueItemId, gateOrdinal: input.gateOrdinal, params: projectBuiltinArguments(input.args, input.descriptor.projection.pointers), ...(result === undefined ? {} : { result }), ...(error === undefined ? {} : { error }) });
}

function denied(reason: string): ToolResult { return { text: `denied by canonical built-in policy (${reason}). Do not retry automatically.`, ok: false }; }
function enforceBuiltinObligations(decision: PolicyDecision, input: BuiltinPolicyResolveInput, resolver: NonNullable<ToolContext["builtinPolicyResolver"]>): void {
  for (const obligation of decision.canonical?.obligations ?? []) {
    if (obligation.type === "target_idempotency" && (!input.queueItemId || !resolver.reserveExecution || !resolver.completeExecution)) throw new Error("Canonical built-in idempotency obligation failed.");
    else if (obligation.type === "sandbox_capabilities") { if (obligation.capabilities.some((capability) => capability !== input.descriptor.capability)) throw new Error("Canonical built-in capability obligation failed."); }
    else throw new Error("Canonical built-in obligation is unsupported.");
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
