import { describe, it, expect } from "vitest";
import { llmProxyRequests } from "./index.js";

describe("llmProxyRequests schema", () => {
  it("has the columns the recorder writes", () => {
    const cols = Object.keys(llmProxyRequests);
    for (const c of [
      "id", "createdAt", "orgId", "userId", "apiKeyId", "providerKind", "model",
      "harness", "endpoint", "providerResponseId", "previousResponseId", "stream",
      "statusCode", "requestBody", "responseBody", "inputTokens", "outputTokens",
      "cacheReadTokens", "cacheWriteTokens", "totalTokens", "costUsd", "latencyMs",
      "error", "parsed", "parseVersion", "parseError",
    ]) {
      expect(cols).toContain(c);
    }
  });
});
