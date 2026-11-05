import { describe, expect, it } from "vitest";
import type { LlmProviderRow } from "../schema/index.js";
import { isKnownProviderKind, isLlmProviderKind, providerNamespace } from "./llm-providers.js";

describe("llm provider kinds", () => {
  it("treats amazon-bedrock as a known kind with the kind as its namespace", () => {
    expect(isLlmProviderKind("amazon-bedrock")).toBe(true);
    expect(isKnownProviderKind("amazon-bedrock")).toBe(true);
    expect(providerNamespace({ kind: "amazon-bedrock", id: "prov_x" } as LlmProviderRow)).toBe("amazon-bedrock");
  });

  it("still rejects unknown kinds", () => {
    expect(isLlmProviderKind("bedrock")).toBe(false);
  });
});
