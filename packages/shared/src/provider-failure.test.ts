import { describe, expect, it } from "vitest";
import { classifyProviderFailure, isNonRetryableProviderFailure, isRateLimitedProviderFailure, providerFailureSummary, providerLabel } from "./provider-failure.js";

describe("classifyProviderFailure", () => {
  it.each([
    ["An error occurred while processing your request. You can retry your request, or contact us through our help center at help.openai.com if the error persists. Please include the request ID req_e2eba03577d9479faf4d9f3371623c2f in your message.", "server_error"],
    ["overloaded_error: Overloaded", "overloaded"],
    ["429 Too Many Requests: rate limit reached for requests", "rate_limited"],
    ["You exceeded your current quota, please check your plan and billing details. (insufficient_quota)", "usage_limit"],
    ["Your credit balance is too low to access the Anthropic API", "usage_limit"],
    ["401 invalid x-api-key", "auth"],
    ["400 prompt is too long: context length exceeded", "rejected"],
    ["fetch failed: ECONNRESET", "network"],
    ["something odd", "unknown"],
  ])("reads %j as %s", (text, kind) => {
    expect(classifyProviderFailure(text)).toBe(kind);
  });

  it("keeps a usage limit that also says 429 out of the retryable kinds", () => {
    expect(classifyProviderFailure("429 insufficient_quota")).toBe("usage_limit");
    expect(isNonRetryableProviderFailure("401 Unauthorized, rate limit")).toBe(true);
  });
});

describe("providerFailureSummary", () => {
  it("names the provider and the next step without the raw text", () => {
    const text = providerFailureSummary("server_error", "openai");
    expect(text).toBe("OpenAI had a server error and did not recover after several tries. Try again, or choose another model.");
    expect(text).not.toContain("help.openai.com");
  });

  it("tells a usage limit apart from an outage", () => {
    expect(providerFailureSummary("usage_limit", "anthropic")).toContain("Anthropic usage limit is reached");
  });
});

describe("providerLabel", () => {
  it("names Amazon Bedrock by its pi-ai provider id", () => {
    expect(providerLabel("amazon-bedrock")).toBe("Amazon Bedrock");
  });
});

describe("Bedrock throttling", () => {
  // pi-ai formats Bedrock's ThrottlingException as "Throttling error: <aws message>".
  const text = "Throttling error: Too many tokens, please wait before trying again.";
  it("classifies pi-ai's Bedrock throttling text as rate_limited", () => {
    expect(classifyProviderFailure(text)).toBe("rate_limited");
    expect(isRateLimitedProviderFailure(text)).toBe(true);
    expect(isNonRetryableProviderFailure(text)).toBe(false);
  });
  it("does not treat ordinary errors as rate limited", () => {
    expect(isRateLimitedProviderFailure("401 invalid x-api-key")).toBe(false);
  });
});
