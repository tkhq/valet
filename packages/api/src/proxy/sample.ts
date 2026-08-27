// packages/api/src/proxy/sample.ts
import type { ProviderKind, ProxyUsage } from "./types.js";
import { parseUsage, isChatCompletionsEndpoint, dataObjects } from "./usage-parser.js";

export const PARSE_VERSION = 1;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type ContentBlock =
  | { type: "text"; text: string }
  | { type: "image"; source: Record<string, unknown> }
  | { type: "tool_use"; id: string; name: string; input: Record<string, unknown> }
  | { type: "tool_result"; tool_use_id: string; content: unknown }
  | { type: "reasoning"; thinking: string }
  | { type: "unknown"; raw: unknown };

export interface SampleMessage {
  role: string;
  content: ContentBlock[];
}

export interface SampleTool {
  name: string;
  description?: string;
  input_schema?: Record<string, unknown>;
}

export interface SampleParams {
  max_tokens?: number;
  temperature?: number;
  top_p?: number;
  stop?: unknown;
  reasoning_effort?: string;
}

export interface Sample {
  schema: "valet.llm-sample/v1";
  provider: ProviderKind;
  parseVersion: number;
  model: string;
  params: SampleParams;
  system: string | null;
  tools: SampleTool[];
  previousResponseId: string | null;
  input: SampleMessage[];
  output: SampleMessage;
  stop_reason: string | null;
  usage: ProxyUsage;
}

// ---------------------------------------------------------------------------
// Content normalization
// ---------------------------------------------------------------------------

function normalizeContent(content: unknown): ContentBlock[] {
  if (typeof content === "string") {
    return [{ type: "text", text: content }];
  }
  if (!Array.isArray(content)) {
    return [];
  }
  return content.map((item): ContentBlock => {
    if (typeof item !== "object" || item === null) {
      return { type: "unknown", raw: item };
    }
    const block = item as Record<string, unknown>;
    const t = block.type;
    if (t === "text") {
      return { type: "text", text: typeof block.text === "string" ? block.text : "" };
    }
    if (t === "image") {
      return {
        type: "image",
        source: typeof block.source === "object" && block.source !== null
          ? (block.source as Record<string, unknown>)
          : {},
      };
    }
    if (t === "tool_use") {
      return {
        type: "tool_use",
        id: typeof block.id === "string" ? block.id : "",
        name: typeof block.name === "string" ? block.name : "",
        input: typeof block.input === "object" && block.input !== null
          ? (block.input as Record<string, unknown>)
          : {},
      };
    }
    if (t === "tool_result") {
      return {
        type: "tool_result",
        tool_use_id: typeof block.tool_use_id === "string" ? block.tool_use_id : "",
        content: block.content,
      };
    }
    if (t === "reasoning" || t === "thinking") {
      return {
        type: "reasoning",
        thinking: typeof block.thinking === "string"
          ? block.thinking
          : typeof block.text === "string" ? block.text : "",
      };
    }
    // OpenAI output_text content in response
    if (t === "output_text") {
      return { type: "text", text: typeof block.text === "string" ? block.text : "" };
    }
    // Any unrecognized type is preserved as unknown
    return { type: "unknown", raw: block };
  });
}

// ---------------------------------------------------------------------------
// Response output assembly
// ---------------------------------------------------------------------------

// Block skeleton recorded from content_block_start events, keyed by index.
interface BlockSkeleton {
  kind: "text" | "tool_use" | "unknown";
  // tool_use fields
  id?: string;
  name?: string;
  rawBlock?: unknown;
}

function assembleAnthropicOutput(
  events: Record<string, unknown>[],
): { content: ContentBlock[]; stop_reason: string | null } {
  // Track block skeletons (type, id, name) per index from content_block_start.
  const skeletonByIndex = new Map<number, BlockSkeleton>();
  // Accumulate streamed text or partial_json per block index.
  const textByIndex = new Map<number, string>();
  let stop_reason: string | null = null;

  for (const e of events) {
    if (e.type === "content_block_start") {
      const index = typeof e.index === "number" ? e.index : 0;
      // Narrow the untyped SSE event field to access content_block properties.
      const cb = e.content_block as Record<string, unknown> | undefined;
      if (!cb) continue;
      const cbType = cb.type;
      if (cbType === "text") {
        skeletonByIndex.set(index, { kind: "text" });
      } else if (cbType === "tool_use") {
        skeletonByIndex.set(index, {
          kind: "tool_use",
          id: typeof cb.id === "string" ? cb.id : "",
          name: typeof cb.name === "string" ? cb.name : "",
        });
      } else {
        // Preserve unrecognized block types rather than dropping them.
        skeletonByIndex.set(index, { kind: "unknown", rawBlock: cb });
      }
    } else if (e.type === "content_block_delta") {
      const index = typeof e.index === "number" ? e.index : 0;
      // Narrow the untyped SSE event field to access delta type and content.
      const delta = e.delta as Record<string, unknown> | undefined;
      if (!delta) continue;
      if (delta.type === "text_delta" && typeof delta.text === "string") {
        textByIndex.set(index, (textByIndex.get(index) ?? "") + delta.text);
      } else if (delta.type === "input_json_delta" && typeof delta.partial_json === "string") {
        textByIndex.set(index, (textByIndex.get(index) ?? "") + delta.partial_json);
      }
    } else if (e.type === "message_delta") {
      // Narrow the untyped SSE event field to access stop_reason.
      const delta = e.delta as Record<string, unknown> | undefined;
      if (delta && typeof delta.stop_reason === "string") {
        stop_reason = delta.stop_reason;
      }
    }
  }

  // Determine the full set of indices from both skeletons and accumulated text.
  const allIndices = new Set([...skeletonByIndex.keys(), ...textByIndex.keys()]);
  const sorted = [...allIndices].sort((a, b) => a - b);

  const content: ContentBlock[] = [];
  for (const index of sorted) {
    const skeleton = skeletonByIndex.get(index);
    const accumulated = textByIndex.get(index) ?? "";

    if (skeleton?.kind === "tool_use") {
      let input: Record<string, unknown> = {};
      if (accumulated) {
        try {
          const parsed: unknown = JSON.parse(accumulated);
          if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
            input = parsed as Record<string, unknown>;
          }
        } catch {
          // Bad partial_json — leave input as empty object.
        }
      }
      content.push({ type: "tool_use", id: skeleton.id ?? "", name: skeleton.name ?? "", input });
    } else if (skeleton?.kind === "unknown") {
      content.push({ type: "unknown", raw: skeleton.rawBlock });
    } else {
      // Text block (explicit skeleton or delta-only index with no skeleton).
      if (accumulated) {
        content.push({ type: "text", text: accumulated });
      }
    }
  }

  return { content, stop_reason };
}

function assembleOpenAIOutput(
  events: Record<string, unknown>[],
): { content: ContentBlock[]; stop_reason: string | null } {
  for (const e of events) {
    if (e.type === "response.completed") {
      const resp = e.response as Record<string, unknown> | undefined;
      if (!resp) continue;
      const output = resp.output;
      if (!Array.isArray(output)) continue;
      // Find the first assistant message item
      for (const item of output) {
        if (typeof item !== "object" || item === null) continue;
        const msg = item as Record<string, unknown>;
        if (msg.type === "message" && msg.role === "assistant") {
          return {
            content: normalizeContent(msg.content),
            stop_reason: typeof resp.status === "string" ? resp.status : null,
          };
        }
      }
    }
  }
  return { content: [], stop_reason: null };
}

/**
 * Assemble the assistant output for OpenAI Chat Completions and legacy
 * Completions. Non-streaming carries the full message on `choices[0].message`
 * (chat) or `choices[0].text` (completions); streaming accumulates
 * `choices[0].delta` (chat) or `choices[0].text` (completions) across chunks,
 * plus `tool_calls` deltas keyed by index. Terminal usage chunks have empty
 * `choices` and are skipped here.
 */
function assembleOpenAIChatOutput(
  events: Record<string, unknown>[],
): { content: ContentBlock[]; stop_reason: string | null } {
  let text = "";
  let stop_reason: string | null = null;
  // tool_call fragments accumulated by index (streaming) or read whole (non-streaming).
  const toolCalls = new Map<number, { id: string; name: string; args: string }>();

  for (const e of events) {
    const choices = e.choices;
    if (!Array.isArray(choices) || choices.length === 0) continue;
    const choice = choices[0] as Record<string, unknown>;
    if (typeof choice.finish_reason === "string") stop_reason = choice.finish_reason;
    // Legacy completions put text directly on the choice.
    if (typeof choice.text === "string") text += choice.text;
    // Chat: `message` (non-streaming) or `delta` (streaming).
    const msg = (choice.message ?? choice.delta) as Record<string, unknown> | undefined;
    if (!msg) continue;
    if (typeof msg.content === "string") text += msg.content;
    if (Array.isArray(msg.tool_calls)) {
      for (const call of msg.tool_calls) {
        if (typeof call !== "object" || call === null) continue;
        const cc = call as Record<string, unknown>;
        const idx = typeof cc.index === "number" ? cc.index : 0;
        const entry = toolCalls.get(idx) ?? { id: "", name: "", args: "" };
        if (typeof cc.id === "string") entry.id = cc.id;
        const fn = cc.function as Record<string, unknown> | undefined;
        if (fn) {
          // name arrives whole in the first delta; arguments stream in pieces.
          if (typeof fn.name === "string") entry.name = fn.name;
          if (typeof fn.arguments === "string") entry.args += fn.arguments;
        }
        toolCalls.set(idx, entry);
      }
    }
  }

  const content: ContentBlock[] = [];
  if (text) content.push({ type: "text", text });
  for (const idx of [...toolCalls.keys()].sort((a, b) => a - b)) {
    const call = toolCalls.get(idx);
    if (!call) continue;
    let input: Record<string, unknown> = {};
    if (call.args) {
      try {
        const parsed: unknown = JSON.parse(call.args);
        if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
          input = parsed as Record<string, unknown>;
        }
      } catch {
        // Incomplete/invalid arguments JSON — leave input empty.
      }
    }
    content.push({ type: "tool_use", id: call.id, name: call.name, input });
  }
  return { content, stop_reason };
}

// ---------------------------------------------------------------------------
// Tool normalization
// ---------------------------------------------------------------------------

function normalizeTool(raw: unknown): SampleTool | null {
  if (typeof raw !== "object" || raw === null) return null;
  const outer = raw as Record<string, unknown>;
  // OpenAI Chat Completions nests the tool under `function`; Anthropic and the
  // Responses API put name/description/schema at the top level.
  const t =
    outer.type === "function" && typeof outer.function === "object" && outer.function !== null
      ? (outer.function as Record<string, unknown>)
      : outer;
  const name = typeof t.name === "string" ? t.name : null;
  if (!name) return null;
  const tool: SampleTool = { name };
  if (typeof t.description === "string") tool.description = t.description;
  // Anthropic/Responses use `input_schema`; Chat Completions uses `parameters`.
  const schema = t.input_schema ?? t.parameters;
  if (typeof schema === "object" && schema !== null) {
    tool.input_schema = schema as Record<string, unknown>;
  }
  return tool;
}

// ---------------------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------------------

export function parseSample(
  kind: ProviderKind,
  requestBody: string,
  responseText: string,
  endpoint?: string,
): Sample | null {
  const isChat = isChatCompletionsEndpoint(endpoint);
  let req: Record<string, unknown>;
  try {
    const parsed = JSON.parse(requestBody);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      return null;
    }
    req = parsed as Record<string, unknown>;
  } catch {
    return null;
  }

  // Model
  const model = typeof req.model === "string" ? req.model : "";

  // Params (best-effort, only present keys)
  const params: SampleParams = {};
  if (typeof req.max_tokens === "number") params.max_tokens = req.max_tokens;
  // Chat Completions renamed max_tokens → max_completion_tokens.
  else if (typeof req.max_completion_tokens === "number") params.max_tokens = req.max_completion_tokens;
  if (typeof req.temperature === "number") params.temperature = req.temperature;
  if (typeof req.top_p === "number") params.top_p = req.top_p;
  if (req.stop !== undefined) params.stop = req.stop;
  if (typeof req.reasoning_effort === "string") params.reasoning_effort = req.reasoning_effort;

  // System
  const system = typeof req.system === "string" ? req.system : null;

  // Tools
  const tools: SampleTool[] = [];
  if (Array.isArray(req.tools)) {
    for (const t of req.tools) {
      const normalized = normalizeTool(t);
      if (normalized) tools.push(normalized);
    }
  }

  // OpenAI previous_response_id
  const previousResponseId =
    typeof req.previous_response_id === "string" ? req.previous_response_id : null;

  // Input messages. Anthropic Messages and OpenAI Chat Completions use
  // `messages`; the Responses API uses `input`; legacy Completions carries a
  // bare `prompt` string (or array of strings) with no roles.
  let input: SampleMessage[];
  if (endpoint === "/v1/completions") {
    const prompt = req.prompt;
    const text =
      typeof prompt === "string"
        ? prompt
        : Array.isArray(prompt)
          ? prompt.filter((p): p is string => typeof p === "string").join("")
          : "";
    input = text ? [{ role: "user", content: [{ type: "text", text }] }] : [];
  } else {
    const rawMessages =
      kind === "anthropic" || isChat
        ? (Array.isArray(req.messages) ? req.messages : [])
        : (Array.isArray(req.input) ? req.input : []);
    input = rawMessages.map((m): SampleMessage => {
      if (typeof m !== "object" || m === null) {
        return { role: "user", content: [] };
      }
      const msg = m as Record<string, unknown>;
      return {
        role: typeof msg.role === "string" ? msg.role : "user",
        content: normalizeContent(msg.content),
      };
    });
  }

  // Parse the response into events — SSE `data:` chunks (streaming) or a single
  // bare-JSON object (non-streaming).
  const events = dataObjects(responseText);

  let content: ContentBlock[];
  let stop_reason: string | null;

  if (kind === "anthropic") {
    ({ content, stop_reason } = assembleAnthropicOutput(events));
  } else if (isChat) {
    ({ content, stop_reason } = assembleOpenAIChatOutput(events));
  } else {
    ({ content, stop_reason } = assembleOpenAIOutput(events));
  }

  const output: SampleMessage = { role: "assistant", content };

  // Usage via parseUsage (endpoint picks the OpenAI wire shape).
  const zero: ProxyUsage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 };
  const usage = parseUsage(kind, responseText, endpoint)?.usage ?? zero;

  return {
    schema: "valet.llm-sample/v1",
    provider: kind,
    parseVersion: PARSE_VERSION,
    model,
    params,
    system,
    tools,
    previousResponseId,
    input,
    output,
    stop_reason,
    usage,
  };
}
