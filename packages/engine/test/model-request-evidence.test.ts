import { expect, it } from "vitest";
import { modelRequestEvidence, modelResponseMetadata } from "../src/model-response.js";
import { fauxAssistantMessage } from "@earendil-works/pi-ai/compat";

it.each([
  [{ max_output_tokens: 8000 }, "max_output_tokens"],
  [{ max_completion_tokens: 8000 }, "max_completion_tokens"],
  [{ max_tokens: 8000 }, "max_tokens"],
  [{ config: { maxOutputTokens: 8000 } }, "config.maxOutputTokens"],
  [{ maxTokens: 8000 }, "maxTokens"],
  [{ generationConfig: { maxOutputTokens: 8000 } }, "generationConfig.maxOutputTokens"],
  [{ inferenceConfig: { maxTokens: 8000 } }, "inferenceConfig.maxTokens"],
])("reads only the sent output limit from %j", (payload, field) => {
  expect(modelRequestEvidence(payload)).toEqual({ effectiveMaxOutputTokens: 8000, outputLimitField: field });
});

it("keeps absent or invalid limits unavailable and drops arbitrary payload fields", () => {
  for (const payload of [null, {}, { max_tokens: -1 }, { max_tokens: "8000" }, { max_tokens: Infinity }, { max_tokens: 1.5 }]) {
    expect(modelRequestEvidence(payload)).toEqual({ effectiveMaxOutputTokens: null, outputLimitField: null });
  }
  const evidence = modelRequestEvidence({ max_output_tokens: 100, api_key: "SECRET", messages: ["PRIVATE"] });
  expect(modelResponseMetadata(fauxAssistantMessage("answer"), 6, undefined, evidence)).toMatchObject({ effectiveMaxOutputTokens: 100, outputLimitField: "max_output_tokens" });
  expect(JSON.stringify(evidence)).not.toMatch(/SECRET|PRIVATE/);
});
