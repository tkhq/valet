// packages/api/src/proxy/recorder.test.ts
import { describe, it, expect, vi } from "vitest";
import { recordProxyCall } from "./recorder.js";

function streamOf(text: string): ReadableStream<Uint8Array> {
  const bytes = new TextEncoder().encode(text);
  return new ReadableStream({ start(c) { c.enqueue(bytes); c.close(); } });
}
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
