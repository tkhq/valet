import { fauxAssistantMessage, fauxToolCall, registerFauxProvider, Type } from "@earendil-works/pi-ai/compat";
import { codeReviewPresetPlan } from "@valet/plugin-security";
import { eq } from "drizzle-orm";
import { expect, it, vi } from "vitest";
import { loadSessionMeta } from "../engine/session-meta.js";
import { NUDGE_TEXT } from "../orchestrator/security-runner-driver.js";
import { agentSessions } from "../schema/index.js";
import { createSecurityEngagementService } from "../services/security-engagements.js";
import { bootTestApi } from "./_setup.js";

it("keeps the task ceiling when the security driver resumes an idle runner", async () => {
  const faux = registerFauxProvider({ provider: "security-nudge-scope" });
  const api = await bootTestApi();
  try {
    const p = api.providers;
    const now = Date.now();
    const sessionId = "scope-runner";
    await p.db.insert(agentSessions).values({ id: sessionId, userId: "local-user", orgId: "local-org", workspace: "/tmp/scope-runner", status: "active", ownerType: "user", ownerId: "local-user", profile: "headless", kind: "security", createdAt: now, updatedAt: now });
    await createSecurityEngagementService({ db: p.db }).createEngagement({ sessionId, repoFullName: "acme/api", plan: codeReviewPresetPlan() });
    const [row] = await p.db.select().from(agentSessions).where(eq(agentSessions.id, sessionId)).limit(1);
    if (!row) throw new Error("runner missing");
    const session = await p.engineHost.sessionFor(sessionId, await loadSessionMeta(p.db, row));
    session.options.resolveModel = async () => ({ model: faux.getModel(), apiKey: "test" });
    session.options.resolveFallbackModel = undefined;
    session.options.compaction = { enabled: false };
    let writes = 0;
    session.options.tools ??= [];
    session.options.tools.push({ name: "write_record", description: "Write", parameters: Type.Object({}), execute: async () => { writes++; return { text: "wrote" }; } });
    const responses = () => [fauxAssistantMessage([fauxToolCall("write_record", {})], { stopReason: "toolUse" }), fauxAssistantMessage("done")];
    faux.setResponses(responses());
    const original = await session.prompt("Inspect engagement", { metadata: { toolScope: { tools: [], actions: [] } } });
    const thread = session.thread();
    await thread.awaitResult(original.queueItemId, { timeoutMs: 5_000 });
    expect(writes).toBe(0);

    faux.setResponses(responses());
    await p.securityRunnerDriver.sweep();
    await vi.waitFor(async () => expect((await thread.readEntries()).some((entry) => entry.type === "message" && entry.role === "user" && entry.content === NUDGE_TEXT)).toBe(true));
    const nudge = (await thread.readEntries()).find((entry) => entry.type === "message" && entry.role === "user" && entry.content === NUDGE_TEXT);
    if (nudge?.type !== "message" || !nudge.queueItemId) throw new Error("nudge missing");
    await thread.awaitResult(nudge.queueItemId, { timeoutMs: 5_000 });
    expect(writes).toBe(0);
    expect((await p.engineStore.getQueueItem(sessionId, nudge.queueItemId))?.metadata?.toolScope).toEqual({ tools: [], actions: [] });
  } finally {
    await api.cleanup();
    faux.unregister();
  }
});
