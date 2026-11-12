import { describe, expect, it } from "vitest";
import type { MessagePart } from "../wire/types.js";
import { fullToolResult, TRIM_ABOVE_CHARS, trimToolResults } from "./transcript-trim.js";

const call = (result: unknown): MessagePart => ({ kind: "tool_call", callId: "c1", toolName: "bash", status: "completed", result });

describe("trimToolResults", () => {
  it("ships a small result whole", () => {
    const parts = [call({ content: [{ type: "text", text: "ok" }] }), { kind: "text" as const, text: "done" }];
    expect(trimToolResults(parts, { entryId: "e1", threadId: "t1" })).toEqual(parts);
  });

  it("keeps the start and the end of a large result, in its own shape, and marks it", () => {
    const text = `START${"a".repeat(TRIM_ABOVE_CHARS * 2)}END`;
    const [content] = trimToolResults([call({ content: [{ type: "text", text }], details: { ok: false } })], { entryId: "e1", threadId: "t1" });
    if (content?.kind !== "tool_call") throw new Error("expected a tool call");
    expect(content.resultTrimmed).toEqual({ chars: text.length, entryId: "e1", threadId: "t1" });
    const trimmed = (content.result as { content: Array<{ text: string }>; details: unknown });
    expect(trimmed.details).toEqual({ ok: false });
    expect(trimmed.content[0]!.text.startsWith("START")).toBe(true);
    expect(trimmed.content[0]!.text.endsWith("END")).toBe(true);
    expect(trimmed.content[0]!.text).toMatch(/KB of output not shown/);
    expect(trimmed.content[0]!.text.length).toBeLessThan(9_000);

    const [plain] = trimToolResults([call(text)], { entryId: "e2", threadId: "t1" });
    expect(plain?.kind === "tool_call" && typeof plain.result === "string" && plain.result.endsWith("END")).toBe(true);
    const [engineShape] = trimToolResults([call({ text, ok: true })], { entryId: "e3", threadId: "t1" });
    expect(engineShape?.kind === "tool_call" && (engineShape.result as { text: string }).text.startsWith("START")).toBe(true);
  });

  it("ships a capped result's preview without its stored whole text, marked for loading", () => {
    const full = "x".repeat(150_000);
    const result = { content: [{ type: "text", text: "preview [lookup output too large]" }], details: { ok: true, fullText: full } };
    const [part] = trimToolResults([call(result)], { entryId: "e1", threadId: "t1" });
    if (part?.kind !== "tool_call") throw new Error("expected a tool call");
    expect(part.resultTrimmed).toEqual({ chars: 150_000, entryId: "e1", threadId: "t1" });
    expect(part.result).toEqual({ content: [{ type: "text", text: "preview [lookup output too large]" }], details: { ok: true } });
    // The tool-output route returns the whole text in the result's own shape.
    expect(fullToolResult(result)).toEqual({ content: [{ type: "text", text: full }], details: { ok: true } });
    expect(fullToolResult({ content: [{ type: "text", text: "small" }] })).toEqual({ content: [{ type: "text", text: "small" }] });
  });
});
