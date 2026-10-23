import { describe, expect, it } from "vitest";
import { getModel } from "@earendil-works/pi-ai/compat";
import { streamSimple } from "@earendil-works/pi-ai/api/openai-responses";

describe("OpenAI reasoning event prerequisites", () => {
  it("requests automatic summaries for GPT-6 Luna Medium", async () => {
    const model = getModel("openai", "gpt-6-luna");
    if (!model) throw new Error("Missing GPT-6 Luna model");
    let payload: unknown;
    const events = streamSimple(model, { messages: [] }, {
      apiKey: "test-key",
      reasoning: "medium",
      onPayload(value) {
        payload = value;
        // Stop before network access; this test inspects the real request builder.
        throw new Error("request inspected");
      },
    });
    for await (const event of events) {
      if (event.type === "error") expect(event.error.errorMessage).toContain("request inspected");
    }
    expect(payload).toMatchObject({
      model: "gpt-6-luna", reasoning: { effort: "medium", summary: "auto" },
    });
  });
});
