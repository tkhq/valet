// packages/api/src/proxy/usage-parser.test.ts
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { parseUsage } from "./usage-parser.js";

const fx = (n: string) =>
  readFileSync(
    fileURLToPath(new URL(`./fixtures/${n}`, import.meta.url)),
    "utf8",
  );

describe("parseUsage", () => {
  it("extracts Anthropic usage, model, and message id", () => {
    const r = parseUsage("anthropic", fx("anthropic-stream.txt"));
    expect(r).not.toBeNull();
    expect(r!.model).toBe("claude-sonnet-4-5-20250929");
    expect(r!.providerResponseId).toBe("msg_01ABC");
    expect(r!.usage).toEqual({
      input: 1200,
      output: 350,
      cacheRead: 10,
      cacheWrite: 40,
      total: 1600,
    });
  });
  it("extracts OpenAI Responses usage, model, and response id", () => {
    const r = parseUsage("openai", fx("openai-responses-stream.txt"));
    expect(r).not.toBeNull();
    expect(r!.model).toBe("gpt-5");
    expect(r!.providerResponseId).toBe("resp_01XYZ");
    expect(r!.usage).toEqual({
      input: 900,
      output: 220,
      cacheRead: 30,
      cacheWrite: 0,
      total: 1120,
    });
  });
  it("returns null when no usage is present", () => {
    expect(parseUsage("anthropic", "event: ping\ndata: {}\n")).toBeNull();
  });
});
