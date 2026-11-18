import { describe, expect, it } from "vitest";
import { secretUseDefaultFor } from "./secret-use-defaults.js";

describe("secretUseDefaultFor", () => {
  it("reads a provider word and a known-format label", () => {
    expect(secretUseDefaultFor("hetzner")).toEqual({ host: "api.hetzner.cloud", header: "authorization", format: "Bearer {secret}" });
    expect(secretUseDefaultFor("OpenAI key")).toEqual({ host: "api.openai.com", header: "authorization", format: "Bearer {secret}" });
    expect(secretUseDefaultFor("Anthropic key")?.header).toBe("x-api-key");
    expect(secretUseDefaultFor("GitHub token")?.host).toBe("api.github.com");
  });

  it("has no default for an unknown provider or one whose key does not go in a header", () => {
    expect(secretUseDefaultFor(undefined)).toBeUndefined();
    expect(secretUseDefaultFor("key")).toBeUndefined();
    expect(secretUseDefaultFor("AWS access key")).toBeUndefined();
    expect(secretUseDefaultFor("telegram")).toBeUndefined();
  });
});
