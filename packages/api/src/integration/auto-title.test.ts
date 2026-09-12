import { fauxAssistantMessage, registerFauxProvider } from "@earendil-works/pi-ai/compat";
import { and, eq } from "drizzle-orm";
import { afterEach, describe, expect, it, vi } from "vitest";
import { agentSessions, sessionThreads } from "../schema/index.js";
import type { CreateSessionResponse, ListThreadsResponse } from "../wire/types.js";
import { bootTestApi, type TestApi } from "./_setup.js";
import { driveTurn } from "./_test-utils.js";

let api: TestApi | undefined;
let unregister: (() => void) | undefined;

afterEach(async () => {
  unregister?.();
  unregister = undefined;
  await api?.cleanup();
  api = undefined;
  vi.unstubAllEnvs();
});

describe("api integration: automatic titles", () => {
  it("maps persisted engine messages and titles both app rows after a completed turn", async () => {
    vi.stubEnv("ANTHROPIC_API_KEY", "fixture-key");
    const faux = registerFauxProvider({ api: "anthropic-messages", provider: "anthropic" });
    unregister = () => faux.unregister();
    faux.appendResponses([fauxAssistantMessage("Completed fake-model response")]);
    api = await bootTestApi();
    const testApi = api;

    const createdResponse = await fetch(`${testApi.baseUrl}/api/sessions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ workspace: "/tmp" }),
    });
    expect(createdResponse.status).toBe(201);
    const { id: sessionId } = (await createdResponse.json()) as CreateSessionResponse;
    const threadsResponse = await fetch(`${testApi.baseUrl}/api/sessions/${sessionId}/threads`);
    expect(threadsResponse.status).toBe(200);
    const { threads } = (await threadsResponse.json()) as ListThreadsResponse;
    const threadId = threads[0]?.id;
    expect(threadId).toBeDefined();
    if (!threadId) throw new Error("created session has no default thread");

    await driveTurn({
      baseUrl: testApi.baseUrl,
      wsUrl: testApi.wsUrl,
      sessionId,
      threadId,
      prompt: "Explain why persisted message mapping matters.",
      settleMs: 100,
    });

    await vi.waitFor(async () => {
      const [session] = await testApi.providers.db
        .select({ title: agentSessions.title })
        .from(agentSessions)
        .where(eq(agentSessions.id, sessionId));
      const [thread] = await testApi.providers.db
        .select({ title: sessionThreads.title })
        .from(sessionThreads)
        .where(
          and(
            eq(sessionThreads.id, threadId),
            eq(sessionThreads.sessionId, sessionId),
          ),
        );
      expect(session?.title).toBe("Test conversation");
      expect(thread?.title).toBe("Test conversation");
    });
  });
});
