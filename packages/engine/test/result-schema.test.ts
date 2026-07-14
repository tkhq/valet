import { describe, it, expect } from "vitest";
import { Type } from "typebox";
import { extractStructuredOutput } from "../src/result-schema.js";

describe("extractStructuredOutput", () => {
  const schema = Type.Object({ answer: Type.Number() });

  it("uses the last fenced ```json block when multiple are present", () => {
    const text = [
      "here's a draft:",
      "```json",
      '{"answer": 1}',
      "```",
      "actually, final answer:",
      "```json",
      '{"answer": 2}',
      "```",
    ].join("\n");
    const { output, error } = extractStructuredOutput(text, schema);
    expect(error).toBeUndefined();
    expect(output).toEqual({ answer: 2 });
  });

  it("prefers the fenced block over surrounding prose", () => {
    const text = 'The answer, as JSON, is:\n```json\n{"answer": 7}\n```\nHope that helps!';
    const { output, error } = extractStructuredOutput(text, schema);
    expect(error).toBeUndefined();
    expect(output).toEqual({ answer: 7 });
  });

  it("parses the whole text as JSON when no fenced block exists", () => {
    const text = '  {"answer": 9}  ';
    const { output, error } = extractStructuredOutput(text, schema);
    expect(error).toBeUndefined();
    expect(output).toEqual({ answer: 9 });
  });

  it("invalid JSON produces an error mentioning parse failure", () => {
    const { output, error } = extractStructuredOutput("{not json", schema);
    expect(output).toBeUndefined();
    expect(error).toMatch(/parse/i);
  });

  it("schema mismatch produces an error naming the failing path", () => {
    const { output, error } = extractStructuredOutput('{"answer": "nope"}', schema);
    expect(output).toBeUndefined();
    expect(error).toBeDefined();
    expect(error).toContain("/answer");
  });

  it("valid JSON matching the schema round-trips as typed output", () => {
    const nested = Type.Object({ items: Type.Array(Type.String()), count: Type.Integer() });
    const text = '```json\n{"items": ["a", "b"], "count": 2}\n```';
    const { output, error } = extractStructuredOutput(text, nested);
    expect(error).toBeUndefined();
    expect(output).toEqual({ items: ["a", "b"], count: 2 });
  });

  it("empty text produces an error", () => {
    const { output, error } = extractStructuredOutput("   ", schema);
    expect(output).toBeUndefined();
    expect(error).toBeDefined();
  });
});
