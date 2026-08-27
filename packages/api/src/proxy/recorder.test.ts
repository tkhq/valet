// packages/api/src/proxy/recorder.test.ts
import { describe, it, expect, vi } from "vitest";
import { recordProxyCall, drain } from "./recorder.js";

function streamOf(text: string): ReadableStream<Uint8Array> {
  const bytes = new TextEncoder().encode(text);
  return new ReadableStream({ start(c) { c.enqueue(bytes); c.close(); } });
}
/** Emit `text` as many small chunks so drain's per-chunk head cap engages. */
function chunkedStreamOf(text: string, chunkSize: number): ReadableStream<Uint8Array> {
  const bytes = new TextEncoder().encode(text);
  return new ReadableStream({
    start(c) {
      for (let i = 0; i < bytes.length; i += chunkSize) c.enqueue(bytes.subarray(i, i + chunkSize));
      c.close();
    },
  });
}

describe("drain", () => {
  it("keeps the stream tail past the head cap so terminal usage survives truncation", async () => {
    const head = "HEAD_START";
    const filler = "x".repeat(4000);
    const tail = "TERMINAL_USAGE_EVENT";
    const out = await drain(chunkedStreamOf(head + filler + tail, 100), { maxHeadBytes: 500, tailBytes: 200 });
    expect(out).toContain(head); // head retained
    expect(out).toContain(tail); // terminal event retained via rolling tail
    expect(out).toContain("truncated middle"); // marker shows the gap
    expect(out).not.toContain(filler); // the middle is dropped
    // Capping is honored: head (~500) + marker + tail (~200), far below the 4030-byte body.
    expect(out.length).toBeLessThan(1000);
  });
  it("returns the whole body untouched when under the head cap", async () => {
    const out = await drain(streamOf("small body"), { maxHeadBytes: 500, tailBytes: 200 });
    expect(out).toBe("small body");
  });
});
const anthropicResp = `event: message_start
data: {"type":"message_start","message":{"id":"msg_1","model":"claude-sonnet-4-5-20250929","role":"assistant","content":[],"usage":{"input_tokens":100,"output_tokens":1}}}

event: message_delta
data: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":50}}
`;

describe("recordProxyCall", () => {
  it("inserts one row with usage, cost, bodies, and parsed sample", async () => {
    const inserted: Record<string, unknown>[] = [];
    await recordProxyCall(
      { insert: async (row) => { inserted.push(row); }, now: () => 1000, id: () => "row1", metric: vi.fn() },
      {
        principal: { userId: "u1", orgId: "org1", keyId: "k1" },
        kind: "anthropic", endpoint: "/v1/messages", harness: "claude-code",
        requestBody: JSON.stringify({ model: "claude-sonnet-4-5-20250929", messages: [{ role: "user", content: "hi" }] }),
        stream: streamOf(anthropicResp), statusCode: 200, startMs: 900,
      },
    );
    expect(inserted).toHaveLength(1);
    const row = inserted[0];
    expect(row).toMatchObject({
      id: "row1", orgId: "org1", userId: "u1", providerKind: "anthropic",
      model: "claude-sonnet-4-5-20250929", inputTokens: 100, outputTokens: 50, totalTokens: 150,
      providerResponseId: "msg_1", statusCode: 200, parseVersion: 1,
    });
    expect(row.costUsd).not.toBeNull();
    expect(String(row.requestBody)).toContain("hi");
    expect(String(row.responseBody)).toContain("message_start");
    expect(row.parsed).toBeTruthy();
  });
  it("prices a Codex row via the request model when the response model is a dated id", async () => {
    // OpenAI reports `gpt-4o-mini-2024-07-18` (not a pi-ai registry key); the
    // request asked for `gpt-4o-mini` (which is). Pricing must fall back to it.
    const openaiResp = `event: response.completed
data: {"type":"response.completed","response":{"id":"resp_1","object":"response","model":"gpt-4o-mini-2024-07-18","output":[],"usage":{"input_tokens":100,"output_tokens":50,"total_tokens":150}}}
`;
    const inserted: Record<string, unknown>[] = [];
    const metric = vi.fn();
    await recordProxyCall(
      { insert: async (r) => { inserted.push(r); }, now: () => 1, id: () => "row3", metric },
      {
        principal: { userId: "u", orgId: "o", keyId: "k" },
        kind: "openai", endpoint: "/v1/responses", harness: "codex",
        requestBody: JSON.stringify({ model: "gpt-4o-mini", input: "hi" }),
        stream: streamOf(openaiResp), statusCode: 200, startMs: 0,
      },
    );
    expect(inserted).toHaveLength(1);
    expect(inserted[0].model).toBe("gpt-4o-mini-2024-07-18"); // row keeps the specific id
    expect(inserted[0].costUsd).not.toBeNull(); // priced via the canonical fallback
    expect(inserted[0].inputTokens).toBe(100);
    expect(inserted[0].outputTokens).toBe(50);
    // Metric is labeled with the model actually priced (canonical), so spend
    // reconciles with the rate — not the dated id.
    expect(metric).toHaveBeenCalledWith(expect.any(Number), expect.objectContaining({ model: "gpt-4o-mini" }));
  });
  it("swallows a parse failure: row still written, cost null", async () => {
    const inserted: Record<string, unknown>[] = [];
    await recordProxyCall(
      { insert: async (r) => { inserted.push(r); }, now: () => 1, id: () => "row2", metric: vi.fn() },
      { principal: { userId: "u", orgId: "o", keyId: "k" }, kind: "openai", endpoint: "/v1/responses",
        harness: "codex", requestBody: "not json", stream: streamOf("garbage"), statusCode: 200, startMs: 0 },
    );
    expect(inserted).toHaveLength(1);
    expect(inserted[0].costUsd).toBeNull();
  });
});
