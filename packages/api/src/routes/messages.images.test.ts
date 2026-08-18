/**
 * Image attachment acceptance for SendPromptRequest.
 *
 * Tests that image attachments are accepted by the POST /messages route
 * and passed through to the engine without error. Full persistence testing
 * is covered by engine tests (entriesToAgentMessages).
 */
import { describe, it, expect, afterEach } from "vitest";
import { bootTestApi, type TestApi } from "../integration/_setup.js";
import type { CreateSessionResponse, SendPromptResponse } from "../wire/types.js";

let api: TestApi | undefined;

afterEach(async () => {
  await api?.cleanup();
  api = undefined;
});

describe("POST /messages: image attachments", () => {
  it("accepts SendPromptRequest with image attachments", async () => {
    api = await bootTestApi();

    const createRes = await fetch(`${api.baseUrl}/api/sessions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ workspace: "/tmp" }),
    });
    expect(createRes.status).toBe(201);
    const { id: sessionId } = (await createRes.json()) as CreateSessionResponse;

    // Create a simple base64-encoded 1x1 PNG
    const pngBase64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";
    const dataUrl = `data:image/png;base64,${pngBase64}`;

    const sendRes = await fetch(`${api.baseUrl}/api/sessions/${sessionId}/messages`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        text: "Describe this image",
        attachments: [
          {
            kind: "image",
            url: dataUrl,
            mimeType: "image/png",
            name: "test.png",
          },
        ],
      }),
    });
    expect(sendRes.status).toBe(202);
    const sendData = (await sendRes.json()) as SendPromptResponse;
    expect(sendData.messageId).toBeDefined();
    expect(sendData.threadId).toBeDefined();
  });
});
