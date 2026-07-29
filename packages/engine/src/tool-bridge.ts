import type { AgentTool, AgentToolResult } from "@mariozechner/pi-agent-core";
import type { TextContent, ImageContent } from "@mariozechner/pi-ai";
import type { ToolDef, ToolContext, ToolResult, ToolAttachment } from "./types.js";
import { attrTruncate, withSpan } from "./tracing.js";
import { recordToolExecution } from "./metrics.js";

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
            const result = await def.execute(params as never, ctx);
            recordToolExecution(def.name, Date.now() - startedAt, true);
            span.setAttribute("valet.tool.result_chars", result.text?.length ?? 0);
            if (result.attachments?.length) {
              span.setAttribute("valet.tool.attachments", result.attachments.length);
            }
            return toAgentToolResult(result);
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

function toAgentToolResult(result: ToolResult): AgentToolResult<unknown> {
  const content: (TextContent | ImageContent)[] = [];
  if (result.text) content.push({ type: "text", text: result.text });
  for (const att of result.attachments ?? []) {
    const block = attachmentToContent(att);
    if (block) content.push(block);
  }
  return { content, details: undefined };
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
