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
  it("normalizes a streaming Chat Completions sample: messages, tool call, tools", () => {
    const req = JSON.stringify({
      model: "gpt-4o-mini",
      stream: true,
      messages: [
        { role: "system", content: "be terse" },
        { role: "user", content: "read foo.ts" },
      ],
      tools: [{ type: "function", function: { name: "read_file", description: "Read a file", parameters: { type: "object" } } }],
    });
    const resp = [
      `data: {"id":"cc1","object":"chat.completion.chunk","model":"gpt-4o-mini","choices":[{"index":0,"delta":{"content":"ok"}}]}`,
      `data: {"id":"cc1","object":"chat.completion.chunk","model":"gpt-4o-mini","choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"id":"call_1","function":{"name":"read_file","arguments":"{\\"path\\":"}}]}}]}`,
      `data: {"id":"cc1","object":"chat.completion.chunk","model":"gpt-4o-mini","choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"function":{"arguments":"\\"foo.ts\\"}"}}]},"finish_reason":"tool_calls"}]}`,
      `data: [DONE]`,
    ].join("\n\n") + "\n";
    const s = parseSample("openai", req, resp, "/v1/chat/completions");
    expect(s).not.toBeNull();
    // Input messages preserved (system captured as a role, not a top-level field).
    expect(s!.input.map((m) => m.role)).toEqual(["system", "user"]);
    // Tools normalized from the nested `function` shape.
    expect(s!.tools).toEqual([{ name: "read_file", description: "Read a file", input_schema: { type: "object" } }]);
    // Output: streamed text + a tool_use assembled from argument deltas.
    const text = s!.output.content.find((c) => c.type === "text");
    expect(text).toMatchObject({ type: "text", text: "ok" });
    const tool = s!.output.content.find((c) => c.type === "tool_use");
    expect(tool).toMatchObject({ type: "tool_use", id: "call_1", name: "read_file", input: { path: "foo.ts" } });
    expect(s!.stop_reason).toBe("tool_calls");
  });
  it("normalizes a legacy Completions prompt into a user message", () => {
    const req = JSON.stringify({ model: "gpt-3.5-turbo-instruct", prompt: "say hi" });
    const resp = JSON.stringify({ id: "cmpl", object: "text_completion", model: "gpt-3.5-turbo-instruct", choices: [{ text: "hi", finish_reason: "stop" }], usage: { prompt_tokens: 2, completion_tokens: 1, total_tokens: 3 } });
    const s = parseSample("openai", req, resp, "/v1/completions");
    expect(s).not.toBeNull();
    expect(s!.input).toEqual([{ role: "user", content: [{ type: "text", text: "say hi" }] }]);
    expect(s!.output.content).toEqual([{ type: "text", text: "hi" }]);
  });
  it("returns null for a malformed request body", () => {
    expect(parseSample("anthropic", "not json", "")).toBeNull();
  });
});
