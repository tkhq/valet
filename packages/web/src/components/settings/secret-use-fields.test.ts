import { describe, expect, it } from "vitest";
import { draftFromDefault, draftIncomplete, ruleFromDraft } from "./secret-use-fields";

describe("secret use fields", () => {
  it("maps a provider default to a header choice", () => {
    expect(draftFromDefault({ host: "api.anthropic.com", header: "x-api-key", format: "{secret}" })).toEqual({ host: "api.anthropic.com", choice: "apiKey", customHeader: "" });
    expect(draftFromDefault({ host: "api.datadoghq.com", header: "dd-api-key", format: "{secret}" })).toEqual({ host: "api.datadoghq.com", choice: "custom", customHeader: "dd-api-key" });
    expect(draftFromDefault(undefined)).toEqual({ host: "", choice: "bearer", customHeader: "" });
  });

  it("builds a rule from a host with a scheme or path, and none without a host", () => {
    expect(ruleFromDraft({ host: " https://api.hetzner.cloud/v1/servers ", choice: "bearer", customHeader: "" })).toEqual({ hosts: ["api.hetzner.cloud"], header: "authorization", format: "Bearer {secret}" });
    expect(ruleFromDraft({ host: "", choice: "bearer", customHeader: "" })).toBeUndefined();
  });

  it("treats a custom header with no name as incomplete", () => {
    const draft = { host: "api.example.com", choice: "custom" as const, customHeader: " " };
    expect(ruleFromDraft(draft)).toBeUndefined();
    expect(draftIncomplete(draft)).toBe(true);
    expect(draftIncomplete({ ...draft, customHeader: "X-Token" })).toBe(false);
    expect(ruleFromDraft({ ...draft, customHeader: "X-Token" })?.header).toBe("x-token");
  });
});
