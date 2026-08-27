// packages/api/src/proxy/sample.test.ts
import { describe, it, expect } from "vitest";
import { parseSample, PARSE_VERSION } from "./sample.js";

const anthropicReq = JSON.stringify({
  model: "claude-sonnet-4-5-20250929", max_tokens: 1024,
  system: "You are helpful.",
  tools: [{ name: "read_file", input_schema: { type: "object" } }],
  messages: [{ role: "user", content: "hi" }],
});
const anthropicResp = `event: message_start
data: {"type":"message_start","message":{"id":"msg_1","model":"claude-sonnet-4-5-20250929","role":"assistant","content":[],"stop_reason":null,"usage":{"input_tokens":10,"output_tokens":1}}}

event: content_block_delta
data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"hello"}}

event: message_delta
data: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":3}}
`;

describe("parseSample", () => {
  it("normalizes an Anthropic request/response", () => {
    const s = parseSample("anthropic", anthropicReq, anthropicResp);
    expect(s).not.toBeNull();
    expect(s!.schema).toBe("valet.llm-sample/v1");
    expect(s!.provider).toBe("anthropic");
    expect(s!.model).toBe("claude-sonnet-4-5-20250929");
    expect(s!.tools.map((t) => t.name)).toContain("read_file");
    expect(s!.input[0]).toMatchObject({ role: "user" });
    expect(s!.output.role).toBe("assistant");
    expect(s!.output.content.find((c) => c.type === "text")).toMatchObject({ text: "hello" });
    expect(s!.stop_reason).toBe("end_turn");
  });
  it("records a Codex previous_response_id and partial input", () => {
    const req = JSON.stringify({ model: "gpt-5", previous_response_id: "resp_prev", input: [{ role: "user", content: "next" }] });
    const resp = `event: response.completed
data: {"type":"response.completed","response":{"id":"resp_now","model":"gpt-5","output":[{"type":"message","role":"assistant","content":[{"type":"output_text","text":"ok"}]}],"usage":{"input_tokens":5,"output_tokens":2,"total_tokens":7}}}
`;
    const s = parseSample("openai", req, resp);
    expect(s!.previousResponseId).toBe("resp_prev");
    expect(s!.output.content.find((c) => c.type === "text")).toMatchObject({ text: "ok" });
  });
  it("preserves an unknown block type rather than dropping it", () => {
    const req = JSON.stringify({ model: "claude-sonnet-4-5-20250929", messages: [{ role: "user", content: [{ type: "weird_new_thing", data: 1 }] }] });
    const s = parseSample("anthropic", req, "data: {}\n");
    expect(s!.input[0].content[0]).toMatchObject({ type: "unknown" });
  });
  it("exposes the parser version", () => { expect(PARSE_VERSION).toBe(1); });
  it("assembles a streamed tool_use block from content_block_start + input_json_delta", () => {
    const resp = [
      `event: content_block_start`,
      `data: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}`,
      ``,
      `event: content_block_delta`,
      `data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"thinking..."}}`,
      ``,
      `event: content_block_start`,
      `data: {"type":"content_block_start","index":1,"content_block":{"type":"tool_use","id":"toolu_1","name":"read_file","input":{}}}`,
      ``,
      `event: content_block_delta`,
      `data: {"type":"content_block_delta","index":1,"delta":{"type":"input_json_delta","partial_json":"{\\"path\\":"}}`,
      ``,
      `event: content_block_delta`,
      `data: {"type":"content_block_delta","index":1,"delta":{"type":"input_json_delta","partial_json":"\\"foo.ts\\"}"}}`,
      ``,
      `event: message_delta`,
      `data: {"type":"message_delta","delta":{"stop_reason":"tool_use"}}`,
    ].join("\n");
    const s = parseSample("anthropic", anthropicReq, resp);
    expect(s).not.toBeNull();
    const blocks = s!.output.content;
    const textBlock = blocks.find((c) => c.type === "text");
    expect(textBlock).toMatchObject({ type: "text", text: "thinking..." });
    const toolBlock = blocks.find((c) => c.type === "tool_use");
    expect(toolBlock).toMatchObject({ type: "tool_use", name: "read_file", input: { path: "foo.ts" } });
    // Block order is preserved: text (index 0) before tool_use (index 1).
    expect(blocks.indexOf(textBlock!)).toBeLessThan(blocks.indexOf(toolBlock!));
    expect(s!.stop_reason).toBe("tool_use");
  });
  it("returns null for a malformed request body", () => {
    expect(parseSample("anthropic", "not json", "")).toBeNull();
  });
});
