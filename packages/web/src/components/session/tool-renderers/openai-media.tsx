/**
 * Chat renderer for the plugin-openai media actions. They reach the LLM
 * through the plugin catalog, so on the wire they are `call_tool`
 * invocations with `args.tool_id = "openai.*"` — this renderer claims that
 * subset via the args-aware `matches` form (same pattern as workflow.tsx).
 *
 * The persisted tool result is pi-agent-core's AgentToolResult plus the
 * engine's flattened `text` (thread.ts `tool_execution_end`): the image
 * actions' PNG arrives as a base64 `{ type: "image", data, mimeType }`
 * content block, so the Body can render it inline with no extra fetch.
 */
import { Sparkles } from "lucide-react";
import { resultText, type ToolRenderer, type ToolRendererProps } from "./types";
import { ToolBody, TruncatedText } from "./tool-shell";

const OPENAI_TOOL_PREFIX = "openai.";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function isOpenaiCallTool(toolName: string, args?: unknown): boolean {
  if (toolName !== "call_tool") return false;
  const toolId = isRecord(args) ? args.tool_id : undefined;
  return typeof toolId === "string" && toolId.startsWith(OPENAI_TOOL_PREFIX);
}

/** The `openai.<action>` id of this call, "" when args are still streaming. */
export function openaiActionId(args: unknown): string {
  const toolId = isRecord(args) ? args.tool_id : undefined;
  return typeof toolId === "string" ? toolId : "";
}

/** The action's own parameters, nested under call_tool's `params`. */
export function openaiParams(args: unknown): Record<string, unknown> {
  const params = isRecord(args) ? args.params : undefined;
  return isRecord(params) ? params : {};
}

/**
 * First image content block of a persisted result, as a data URL. The
 * engine persists pi-agent-core's content blocks verbatim, so the base64
 * payload survives reload (CLAUDE.md tool-call persistence round trip).
 */
export function imageDataUrl(result: unknown): string | undefined {
  if (!isRecord(result) || !Array.isArray(result.content)) return undefined;
  for (const block of result.content) {
    if (!isRecord(block) || block.type !== "image") continue;
    const data = block.data;
    const mimeType = block.mimeType;
    if (typeof data === "string" && data.length > 0) {
      return `data:${typeof mimeType === "string" ? mimeType : "image/png"};base64,${data}`;
    }
  }
  return undefined;
}

/** The action's structured result (`{ path, text, … }`), parsed from the
 * JSON the catalog flattens into the first text block. */
export function openaiResultData(result: unknown): Record<string, unknown> {
  const text = resultText(result);
  if (!text.startsWith("{")) return {};
  try {
    const parsed: unknown = JSON.parse(text);
    return isRecord(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function formatTarget(args: unknown): string | undefined {
  const action = openaiActionId(args);
  const params = openaiParams(args);
  const short = (value: unknown): string | undefined =>
    typeof value === "string" && value.length > 0
      ? value.length > 64
        ? `${value.slice(0, 64)}…`
        : value
      : undefined;
  switch (action) {
    case "openai.generate_image":
    case "openai.edit_image":
      return short(params.prompt);
    case "openai.transcribe_audio":
      return short(params.audio_path);
    case "openai.text_to_speech":
      return short(params.text);
    default:
      return action || undefined;
  }
}

function formatSummary(args: unknown, result: unknown): string | undefined {
  const data = openaiResultData(result);
  if (openaiActionId(args) === "openai.transcribe_audio") {
    const text = data.text;
    return typeof text === "string" && text.length > 0 ? `${text.length} chars` : undefined;
  }
  return typeof data.path === "string" ? data.path.split("/").pop() : undefined;
}

function Body({ args, result, status, error }: ToolRendererProps) {
  if (status === "running" || status === "streaming") {
    return <ToolBody>Working…</ToolBody>;
  }
  const text = error ?? resultText(result);
  const data = openaiResultData(result);
  const action = openaiActionId(args);
  const imageUrl = imageDataUrl(result);
  const transcript = action === "openai.transcribe_audio" && typeof data.text === "string" ? data.text : undefined;

  if (error || status === "error") {
    return (
      <ToolBody>
        <TruncatedText text={text} />
      </ToolBody>
    );
  }
  return (
    <ToolBody className="space-y-2">
      {imageUrl ? (
        <img
          src={imageUrl}
          alt={typeof openaiParams(args).prompt === "string" ? String(openaiParams(args).prompt) : "generated image"}
          className="max-h-96 max-w-full rounded border border-neutral-200 dark:border-neutral-800"
        />
      ) : null}
      {transcript !== undefined ? (
        <TruncatedText text={transcript} />
      ) : null}
      {typeof data.path === "string" ? (
        <div className="font-mono text-neutral-500">{data.path}</div>
      ) : null}
      {!imageUrl && transcript === undefined && typeof data.path !== "string" ? (
        <TruncatedText text={text} />
      ) : null}
    </ToolBody>
  );
}

export const openaiMediaRenderer: ToolRenderer = {
  matches: isOpenaiCallTool,
  category: "write",
  Icon: Sparkles,
  formatTarget,
  formatSummary,
  Body,
};
