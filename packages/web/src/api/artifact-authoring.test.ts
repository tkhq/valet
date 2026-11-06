import { afterEach, describe, expect, it, vi } from "vitest";
import { api } from "./client";

afterEach(() => vi.unstubAllGlobals());

function captureRequests() {
  const calls: { url: string; init?: RequestInit }[] = [];
  vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
    calls.push({ url, init });
    return new Response(JSON.stringify({ id: "artifact-1" }), { status: 200 });
  });
  return calls;
}

describe("artifact authoring transport", () => {
  it("publishes templates in the chosen owner and authorized source conversation", async () => {
    const calls = captureRequests();
    await api.createArtifactFromTemplate(
      { key: "artifacts/brief-1", content: "# Brief", format: "markdown" },
      { ownerType: "team", ownerId: "team:1" },
      { sessionId: "workspace:team:1", threadId: "thread:1" },
    );
    expect(calls[0]?.url).toBe("/api/artifacts/share?ownerType=team&ownerId=team%3A1");
    expect(calls[0]?.init?.headers).toMatchObject({
      "Content-Type": "application/json",
      "x-valet-session-id": "workspace:team:1",
      "x-valet-thread-id": "thread:1",
    });
    expect(JSON.parse(String(calls[0]?.init?.body))).toEqual({ key: "artifacts/brief-1", content: "# Brief", format: "markdown" });
  });

  it("addresses protected revisions and sends the captured base version", async () => {
    const calls = captureRequests();
    await api.getArtifactEditor("artifact:1", 2);
    expect(calls[0]?.url).toBe("/api/artifacts/artifact%3A1/editor?version=2");
    const request = { baseVersion: 3, instruction: "Shorten this", selection: { text: "Selected words", start: 20, end: 34 } };
    await api.requestArtifactEdit("artifact:1", request);
    expect(calls[1]?.url).toBe("/api/artifacts/artifact%3A1/edit-requests");
    expect(JSON.parse(String(calls[1]?.init?.body))).toEqual(request);
    await api.restoreArtifact("artifact:1", { version: 1, baseVersion: 3 });
    expect(calls[2]?.url).toBe("/api/artifacts/artifact%3A1/restore");
    expect(JSON.parse(String(calls[2]?.init?.body))).toEqual({ version: 1, baseVersion: 3 });
  });
});
