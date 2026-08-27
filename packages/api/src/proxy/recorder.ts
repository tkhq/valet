// packages/api/src/proxy/recorder.ts
import { parseUsage } from "./usage-parser.js";
import { parseSample, PARSE_VERSION } from "./sample.js";
import { priceUsage, resolveCanonicalModel } from "../lib/pricing.js";
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

/** Cap the recorder's in-memory buffer of the tee'd response. A large tool
 * result (or a slow client back-pressuring the tee) would otherwise hold the
 * full body in heap per request. Past the head cap we keep draining (so the tee
 * doesn't stall the client's branch) and keep a rolling TAIL — the usage event
 * (`message_delta` / `response.completed`) lives at the END of the stream, so
 * dropping it would leave a >5MB response unpriced. Head + tail keeps usage
 * parseable while bounding memory. */
const MAX_RECORDED_HEAD_BYTES = 5 * 1024 * 1024;
const RECORDED_TAIL_BYTES = 256 * 1024;

export async function drain(
  stream: ReadableStream<Uint8Array> | null,
  opts?: { maxHeadBytes?: number; tailBytes?: number },
): Promise<string> {
  if (!stream) return "";
  const maxHead = opts?.maxHeadBytes ?? MAX_RECORDED_HEAD_BYTES;
  const tailMax = opts?.tailBytes ?? RECORDED_TAIL_BYTES;
  const reader = stream.getReader();
  const head: Uint8Array[] = [];
  const tail: Uint8Array[] = [];
  let headBytes = 0;
  let tailBytes = 0;
  let truncated = false;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      if (!value) continue;
      if (headBytes < maxHead) {
        head.push(value);
        headBytes += value.byteLength;
      } else {
        truncated = true;
        tail.push(value);
        tailBytes += value.byteLength;
        while (tailBytes > tailMax && tail.length > 1) {
          tailBytes -= tail[0].byteLength;
          tail.shift();
        }
      }
    }
  } catch {
    /* client disconnect mid-stream: record what arrived */
  }
  const decode = async (chunks: Uint8Array[]): Promise<string> => new TextDecoder().decode(await new Blob(chunks).arrayBuffer());
  const headText = await decode(head);
  if (!truncated) return headText;
  // The tail carries the terminal usage/completion events for parsing.
  return `${headText}\n…[truncated middle]…\n${await decode(tail)}`;
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

/** The model id the client requested (both APIs carry `model` in the request
 * JSON). Used as a pricing fallback when the response reports a dated model id
 * that isn't a key in pi-ai's registry. */
function requestModelOf(requestBody: string): string | null {
  try {
    const v = (JSON.parse(requestBody) as Record<string, unknown>).model;
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
    const responseModel = parsedUsage?.model ?? null;
    const requestModel = requestModelOf(ctx.requestBody);
    // Row model prefers the response's (more specific, possibly dated) id;
    // falls back to the requested id when the response omitted it.
    const model = responseModel ?? requestModel;
    // Resolve the registry key whose rate prices this call — the response id
    // (date-stripped if needed, e.g. `gpt-4o-mini-2024-07-18` → `gpt-4o-mini`),
    // else the requested id. Using the SAME id for the cost and the metric
    // label keeps spend reconcilable with the rate that produced it.
    const pricedModel =
      (responseModel ? resolveCanonicalModel(ctx.kind, responseModel) : null) ??
      (requestModel ? resolveCanonicalModel(ctx.kind, requestModel) : null);
    const cost = pricedModel ? priceUsage(ctx.kind, pricedModel, usage) : null;

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

    // Emit whenever we have a price (including a legitimate $0 for a known
    // model — the metric layer no-ops on 0), labeled with the model actually
    // priced so the metric reconciles with the rate.
    if (cost !== null && pricedModel) {
      deps.metric(cost, { model: pricedModel, userId: ctx.principal.userId, keyId: ctx.principal.keyId, kind: ctx.kind });
    }
  } catch (err) {
    console.error("recordProxyCall failed (client stream already delivered):", err);
  }
}
