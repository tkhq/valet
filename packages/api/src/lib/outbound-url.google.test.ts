import { describe, expect, it } from "vitest";
import { completeSimple, getModel } from "@earendil-works/pi-ai/compat";
import { modelFetchFor } from "./outbound-url.js";

describe("Google models with the outbound guard", () => {
  it("reach the Google adapter instead of failing on a custom fetch", async () => {
    const model = getModel("google", "gemini-2.5-flash");
    const result = await completeSimple(
      model,
      { messages: [{ role: "user", content: [{ type: "text", text: "hi" }], timestamp: Date.now() }] },
      { apiKey: "not-a-real-key", fetch: modelFetchFor(model), maxRetries: 0, signal: AbortSignal.abort() },
    );
    // The adapter checks the fetch option before it sends anything; the
    // aborted signal then stops the request, so the test needs no network.
    expect(result.errorMessage ?? "").not.toContain("Custom fetch is not supported");
    const refused = await completeSimple(
      model,
      { messages: [{ role: "user", content: [{ type: "text", text: "hi" }], timestamp: Date.now() }] },
      { apiKey: "not-a-real-key", fetch: async () => new Response("unused"), maxRetries: 0, signal: AbortSignal.abort() },
    );
    expect(refused.errorMessage).toContain("Custom fetch is not supported");
  });
});
