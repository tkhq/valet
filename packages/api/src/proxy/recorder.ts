// packages/api/src/proxy/recorder.ts
import { parseUsage } from "./usage-parser.js";
import { parseSample, PARSE_VERSION } from "./sample.js";
import { priceUsage } from "../lib/pricing.js";
import type { ProviderKind, ProxyPrincipal } from "./types.js";

export interface RecordContext {
  principal: ProxyPrincipal;
  kind: ProviderKind;
  endpoint: string;
  harness: string;
  requestBody: string;
  stream: ReadableStream<Uint8Array> | null;
  statusCode: number;
  startMs: number;
}

export interface RecorderDeps {
  insert: (row: Record<string, unknown>) => Promise<void>;
  now: () => number;
  id: () => string;
  metric: (costUsd: number, attrs: { model: string; userId: string; keyId: string; kind: string }) => void;
}

/**
 * Read the `stream` boolean from the parsed request body (both Anthropic and
 * OpenAI place a boolean `stream` field at the top level). Falls back to
 * `!!ctx.stream` when the body does not parse or omits the field.
 */
function streamFlagFromBody(requestBody: string, fallback: boolean): boolean {
  try {
    const b = JSON.parse(requestBody) as Record<string, unknown>;
    if (typeof b.stream === "boolean") return b.stream;
  } catch {
    // non-JSON body (e.g. empty string on GET) — use fallback
  }
  return fallback;
}

async function drain(stream: ReadableStream<Uint8Array> | null): Promise<string> {
  if (!stream) return "";
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      if (value) chunks.push(value);
    }
  } catch {
    /* client disconnect mid-stream: record what arrived */
  }
  return new TextDecoder().decode(await new Blob(chunks).arrayBuffer());
}

function previousResponseId(kind: ProviderKind, requestBody: string): string | null {
  if (kind !== "openai") return null;
  try {
    const b = JSON.parse(requestBody) as Record<string, unknown>;
    const v = b.previous_response_id;
    return typeof v === "string" ? v : null;
  } catch {
    return null;
  }
}

/**
 * Consumes the recorder's tee branch to completion, parses usage, prices it,
 * normalizes the sample, and writes exactly one row. NEVER throws to the
 * caller — the client stream was already delivered, so a recording failure
 * is logged and swallowed (spec section 5).
 */
export async function recordProxyCall(deps: RecorderDeps, ctx: RecordContext): Promise<void> {
  try {
    const responseBody = await drain(ctx.stream);
    const parsedUsage = parseUsage(ctx.kind, responseBody);
    const usage = parsedUsage?.usage ?? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 };
    const model = parsedUsage?.model ?? null;
    const cost = model ? priceUsage(ctx.kind, model, usage) : null;

    let parsed: unknown = null;
    let parseError: string | null = null;
    try {
      parsed = parseSample(ctx.kind, ctx.requestBody, responseBody);
    } catch (e) {
      parseError = e instanceof Error ? e.message : String(e);
    }

    const now = deps.now();
    await deps.insert({
      id: deps.id(),
      createdAt: now,
      orgId: ctx.principal.orgId,
      userId: ctx.principal.userId,
      apiKeyId: ctx.principal.keyId,
      providerKind: ctx.kind,
      model,
      harness: ctx.harness,
      endpoint: ctx.endpoint,
      providerResponseId: parsedUsage?.providerResponseId ?? null,
      previousResponseId: previousResponseId(ctx.kind, ctx.requestBody),
      stream: streamFlagFromBody(ctx.requestBody, !!ctx.stream),
      statusCode: ctx.statusCode,
      requestBody: ctx.requestBody,
      responseBody,
      inputTokens: usage.input,
      outputTokens: usage.output,
      cacheReadTokens: usage.cacheRead,
      cacheWriteTokens: usage.cacheWrite,
      totalTokens: usage.total,
      costUsd: cost,
      latencyMs: now - ctx.startMs,
      error: ctx.statusCode >= 400 ? responseBody.slice(0, 2000) : null,
      parsed,
      parseVersion: parsed ? PARSE_VERSION : null,
      parseError,
    });

    if (cost && model) {
      deps.metric(cost, { model, userId: ctx.principal.userId, keyId: ctx.principal.keyId, kind: ctx.kind });
    }
  } catch (err) {
    console.error("recordProxyCall failed (client stream already delivered):", err);
  }
}
