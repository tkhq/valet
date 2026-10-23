import { parseToolIntent, requiresToolIntent, stripToolIntent, withToolIntentSchema, actionInScope, toolInScope, scopeRefusal } from "@valet/shared";
import { IsObject } from "typebox";
import type { AgentTool, AgentToolResult } from "@earendil-works/pi-agent-core";
import type { TextContent, ImageContent } from "@earendil-works/pi-ai/compat";
import type { ToolDef, ToolContext, ToolResult, ToolAttachment } from "./types.js";
import { attrTruncate, withSpan } from "./tracing.js";
import { recordToolExecution } from "./metrics.js";

const warnedIntentTools = new Set<string>();

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
    toolIntent?: string;
  }) => ToolContext,
  replay = false,
): AgentTool<TParams> {
  if (def.intent === undefined && IsObject(def.parameters) && Object.hasOwn(def.parameters.properties, "intent") && !warnedIntentTools.has(def.name)) {
    warnedIntentTools.add(def.name);
    console.warn(`Tool ${def.name} declares its own intent parameter. Intent telemetry is skipped for this tool.`);
  }
  return {
    name: def.name,
    label: def.name,
    description: def.description,
    parameters: withToolIntentSchema(def, def.parameters),
    ...(requiresToolIntent(def) || def.intent === "summary" ? {
      prepareArguments: (value: unknown) => {
        const args = value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
        const parsed = stripToolIntent(def, args);
        // The SDK validates the original tool fields immediately after preparation.
        return { ...parsed.args, [def.intent === "summary" ? "summary" : "intent"]: parsed.intent } as import("typebox").Static<TParams>;
      },
    } : {}),
    // Sequential unless the tool opts in (TKAI-318). One sequential tool
    // serializes its whole batch in pi-agent-core, so a response mixing a
    // read with a write runs fully in model order — mutations never race
    // and approval gates surface in execution order. An approval-capable
    // tool is forced sequential even when marked concurrencySafe: a
    // parallel approval gate is exactly the out-of-order bug this exists
    // to prevent, and the flag must not be able to resurrect it.
    executionMode:
      def.concurrencySafe && !def.requiresApproval ? "parallel" : "sequential",
    execute: async (toolCallId, params, signal) => {
      const provided = params as Record<string, unknown>;
      // Old suspended calls predate intent. This path is never used for a fresh call.
      const field = def.intent === "summary" ? "summary" : "intent";
      let original = provided;
      if (replay && (requiresToolIntent(def) || def.intent === "summary")) {
        try { parseToolIntent(provided[field]); }
        catch { original = { ...provided, [field]: "Resume the previously suspended tool call." }; }
      }
      let intent: string | null = null;
      let clean = original;
      let validationError: Error | undefined;
      try { const parsed = stripToolIntent(def, original); clean = parsed.args; intent = parsed.intent; }
      catch (error) { validationError = error instanceof Error ? error : new Error("Add a valid intent and retry the tool."); clean = {}; }
      const ctx = buildContext({
        signal: signal ?? new AbortController().signal,
        toolCallId,
        toolName: def.name,
        toolArgs: clean,
        ...(intent ? { toolIntent: intent } : {}),
      });
      if (validationError) {
        return toAgentToolResult({ text: validationError.message, ok: false }, def.name);
      }
      if (def.name !== "focus_tools" && !(def.scopeAction
        ? actionInScope(ctx.toolScope, def.scopeAction) : toolInScope(ctx.toolScope, def.name))) {
        return toAgentToolResult({ text: scopeRefusal(def.scopeAction ?? def.name), ok: false, usageOutcome: { outcome: "denied", errorCode: "policy_denied" } }, def.name);
      }
      // Every engine tool call funnels through this bridge — one span per
      // execution, a child of the running agent.turn via the active context.
      // A decision-gate suspension throws out of execute; the span ends with
      // error status, which doubles as the suspension marker in the trace.
      // Sizes, not content: args/result text can be huge and/or sensitive.
      // `path` is the one arg surfaced verbatim — file tools all take it and
      // it is the highest-value single attribute when debugging a tool call.
      const argsRecord = clean;
      const path = typeof argsRecord.path === "string" ? argsRecord.path : undefined;
      return withSpan(
        `tool.${def.name}`,
        {
          "valet.tool.name": def.name,
          "valet.tool.call_id": toolCallId,
          "valet.tool.args_chars": JSON.stringify(clean).length,
          ...(path !== undefined ? { "valet.tool.path": attrTruncate(path) } : {}),
        },
        async (span) => {
          const startedAt = Date.now();
          try {
            const result = await def.execute(clean as never, ctx);
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
  // Action success and recognized terminal side effects ride in details so
  // both survive transcript persistence without changing model-visible text.
  const details = {
    ...(result.usageOutcome ? { usageOutcome: result.usageOutcome } : {}),
    ...(result.ok === undefined ? {} : { ok: result.ok }),
    ...(result.outcome === undefined ? {} : { outcome: result.outcome }),
  };
  return { content, details: Object.keys(details).length === 0 ? undefined : details };
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
