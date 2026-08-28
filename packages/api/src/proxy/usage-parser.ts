// packages/api/src/proxy/usage-parser.ts
import type { ProviderKind, ParsedUsage, ProxyUsage } from "./types.js";

/** Parse SSE `data:` payloads (and a bare JSON body) into JSON objects. */
export function dataObjects(text: string): Record<string, unknown>[] {
  const trimmed = text.trimStart();
  if (trimmed.startsWith("{")) {
    try {
      return [JSON.parse(trimmed) as Record<string, unknown>];
    } catch {
      return [];
    }
  }
  const out: Record<string, unknown>[] = [];
  for (const line of text.split("\n")) {
    const s = line.trimStart();
    if (!s.startsWith("data:")) continue;
    const payload = s.slice(5).trim();
    if (!payload || payload === "[DONE]") continue;
    try {
      out.push(JSON.parse(payload) as Record<string, unknown>);
    } catch {
      /* skip partial lines */
    }
  }
  return out;
}

function num(v: unknown): number {
  return typeof v === "number" ? v : 0;
}

/** OpenAI wire shapes split by endpoint: `/v1/responses` reports usage as
 * `input_tokens`/`output_tokens`, while `/v1/chat/completions` and the legacy
 * `/v1/completions` report `prompt_tokens`/`completion_tokens`. Both live under
 * the same `openai` provider kind, so the endpoint picks the shape. */
export const OPENAI_CHAT_ENDPOINTS = new Set(["/v1/chat/completions", "/v1/completions"]);

export function isChatCompletionsEndpoint(endpoint: string | undefined): boolean {
  return endpoint !== undefined && OPENAI_CHAT_ENDPOINTS.has(endpoint);
}

export function parseUsage(
  kind: ProviderKind,
  responseText: string,
  endpoint?: string,
): ParsedUsage | null {
  const events = dataObjects(responseText);
  const usage: ProxyUsage = {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    total: 0,
  };
  let model: string | null = null;
  let providerResponseId: string | null = null;
  let sawUsage = false;

  if (kind === "anthropic") {
    for (const e of events) {
      if (e.type === "message_start") {
        const msg = e.message as Record<string, unknown> | undefined;
        if (msg) {
          if (typeof msg.model === "string") model = msg.model;
          if (typeof msg.id === "string") providerResponseId = msg.id;
          const u = msg.usage as Record<string, unknown> | undefined;
          if (u) {
            usage.input = num(u.input_tokens);
            usage.cacheWrite = num(u.cache_creation_input_tokens);
            usage.cacheRead = num(u.cache_read_input_tokens);
            sawUsage = true;
          }
        }
      } else if (e.type === "message_delta") {
        const u = e.usage as Record<string, unknown> | undefined;
        if (u) {
          usage.output = num(u.output_tokens);
          sawUsage = true;
        }
      } else if (e.type === "message") {
        // Non-streaming: the full message object carries final usage (both
        // input and output) in one body.
        if (typeof e.model === "string") model = e.model;
        if (typeof e.id === "string") providerResponseId = e.id;
        const u = e.usage as Record<string, unknown> | undefined;
        if (u) {
          usage.input = num(u.input_tokens);
          usage.output = num(u.output_tokens);
          usage.cacheWrite = num(u.cache_creation_input_tokens);
          usage.cacheRead = num(u.cache_read_input_tokens);
          sawUsage = true;
        }
      }
    }
    if (!sawUsage) return null;
    // Cache tokens are separate from input tokens for Anthropic.
    usage.total = usage.input + usage.output + usage.cacheRead + usage.cacheWrite;
  } else if (isChatCompletionsEndpoint(endpoint)) {
    // OpenAI Chat Completions / legacy Completions. Usage shape is
    // `prompt_tokens`/`completion_tokens`/`total_tokens`. Non-streaming carries
    // it on the single body object; streaming carries it on a terminal chunk
    // with `choices: []` (present only when the request set
    // `stream_options.include_usage` — the gateway auto-injects that). Model
    // and id repeat on every chunk, so read them wherever they appear.
    let reportedTotal = 0;
    for (const e of events) {
      if (typeof e.model === "string") model = e.model;
      if (typeof e.id === "string") providerResponseId = e.id;
      const u = e.usage as Record<string, unknown> | undefined;
      if (u) {
        usage.input = num(u.prompt_tokens);
        usage.output = num(u.completion_tokens);
        reportedTotal = num(u.total_tokens);
        // cached_tokens is a subset of prompt_tokens, not additive.
        const details = u.prompt_tokens_details as Record<string, unknown> | undefined;
        usage.cacheRead = num(details?.cached_tokens);
        sawUsage = true;
      }
    }
    if (!sawUsage) return null;
    usage.total = reportedTotal || usage.input + usage.output;
  } else {
    // OpenAI Responses API
    let openaiReportedTotal = 0;
    for (const e of events) {
      // Streaming emits `{type:"response.completed", response:{…}}`; a
      // non-streaming body IS the response object (`{object:"response", …}`).
      const resp =
        (e.type === "response.completed" ? (e.response as Record<string, unknown> | undefined) : undefined) ??
        (e.object === "response" ? e : undefined);
      if (resp) {
        if (typeof resp.model === "string") model = resp.model;
        if (typeof resp.id === "string") providerResponseId = resp.id;
        const u = resp.usage as Record<string, unknown> | undefined;
        if (u) {
          usage.input = num(u.input_tokens);
          usage.output = num(u.output_tokens);
          openaiReportedTotal = num(u.total_tokens);
          const details = u.input_tokens_details as
            | Record<string, unknown>
            | undefined;
          // cached_tokens is a subset of input_tokens, not additive.
          usage.cacheRead = num(details?.cached_tokens);
          sawUsage = true;
        }
      }
    }
    if (!sawUsage) return null;
    // Use the provider-reported total to avoid double-counting cached tokens.
    usage.total = openaiReportedTotal || usage.input + usage.output;
  }

  return { usage, model, providerResponseId };
}
