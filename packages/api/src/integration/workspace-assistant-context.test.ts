import { afterEach, expect, it, vi } from "vitest";
import { fauxAssistantMessage, registerFauxProvider, type FauxProviderRegistration } from "@earendil-works/pi-ai/compat";
import { bootTestApi, type TestApi } from "./_setup.js";

let api: TestApi | undefined;
let faux: FauxProviderRegistration | undefined;
afterEach(async () => { await api?.cleanup(); api = undefined; faux?.unregister(); faux = undefined; vi.unstubAllEnvs(); });

it("stores page hints per helper submission and drops unsupported or unsafe hints without blocking messages", async () => {
  vi.stubEnv("ANTHROPIC_API_KEY", "faux-key");
  faux = registerFauxProvider({ api: "anthropic-messages", provider: "anthropic" });
  faux.appendResponses(Array.from({ length: 5 }, () => () => fauxAssistantMessage("Ready.")));
  api = await bootTestApi();
  const local = api;
  const response = await fetch(`${local.baseUrl}/api/workspaces/user/conversation`, { method: "POST" });
  const conversation: unknown = await response.json();
  if (!conversation || typeof conversation !== "object" || !("sessionId" in conversation) || typeof conversation.sessionId !== "string" || !("threadId" in conversation) || typeof conversation.threadId !== "string") throw new Error("No helper conversation");
  const { sessionId, threadId } = conversation;
  const hints = [
    { pathname: "/settings/profile", workspace: "user" },
    { pathname: "/integrations", workspace: "user" },
    { pathname: "/settings/appearance", workspace: "user" },
    { pathname: "/unknown-route", workspace: "user" },
    { pathname: "/settings?token=secret", workspace: "user" },
  ];
  for (const [index, appPageHint] of hints.entries()) {
    const text = `Help ${index}`;
    const sent = await fetch(`${local.baseUrl}/api/sessions/${encodeURIComponent(sessionId)}/messages`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ text, threadId, appPageHint }),
    });
    expect(sent.status).toBe(202);
    await vi.waitFor(async () => {
      const entries = await local.providers.engineStore.getEntries(sessionId, threadId);
      const entry = entries.find(e => e.type === "message" && e.role === "user" && e.content === text);
      expect(entry).toBeDefined();
      expect(entry?.metadata?.appPageHint).toEqual(index < 2 ? appPageHint : undefined);
    });
  }
});
