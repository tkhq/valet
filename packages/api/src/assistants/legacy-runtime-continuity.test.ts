import { afterEach, expect, it, vi } from "vitest";
import { sql } from "drizzle-orm";
import { registerFauxProvider, fauxAssistantMessage } from "@earendil-works/pi-ai/compat";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { bootTestApi, type TestApi } from "../integration/_setup.js";
import { createTeam, addMember } from "../services/teams.js";
import { legacyAssistantRuntimes, legacyAssistantConversations } from "../schema/index.js";
import { ensureDefaultAssistantSession, ensureAssistantExecution } from "./service.js";

let api: TestApi | undefined;
let directory: string | undefined;
let removeProvider: (() => void) | undefined;
afterEach(async () => {
  await api?.cleanup();
  removeProvider?.();
  if (directory) await rm(directory, { recursive: true, force: true });
});

it("keeps legacy chats writable, their working directory usable, and pending approval intact across two restores", async () => {
  const faux = registerFauxProvider({ provider: "legacy-continuity" });
  removeProvider = () => faux.unregister();
  faux.setResponses([fauxAssistantMessage("Continued old chat"), fauxAssistantMessage("Continued again")]);
  api = await bootTestApi();
  const p = api.providers;
  const team = await createTeam(p.db, { orgId: "local-org", name: "Legacy continuity", creatorUserId: "local-user" });
  await addMember(p.db, { teamId: team.id, userId: "test-member", role: "member" });
  const owner = { type: "team", id: team.id } as const;
  const meta = { orgId: "local-org", actorUserId: "local-user" };
  const root = await ensureDefaultAssistantSession(p, owner, meta);
  const first = await root.session.createThread("web:old-chat");
  const pending = await root.session.createThread("web:pending-approval");
  // The migration snapshot is tested separately against an old-schema database.
  await p.db.insert(legacyAssistantRuntimes).values({ sessionId: root.sessionId, orgId: meta.orgId });
  await p.db.insert(legacyAssistantConversations).values([
    { sessionId: root.sessionId, threadId: first.id, conversationKey: first.key },
    { sessionId: root.sessionId, threadId: pending.id, conversationKey: pending.key },
  ]);
  directory = await mkdtemp(join(tmpdir(), "valet-legacy-files-"));
  const script = 'const fs = require("node:fs"); process.stdout.write(fs.readFileSync("input.txt", "utf8"));';
  await writeFile(join(directory, "dashboard.cjs"), script);
  await writeFile(join(directory, "input.txt"), "existing recruiting data");
  await p.db.execute(sql`UPDATE engine_sessions SET workspace = ${directory} WHERE id = ${root.sessionId}`);
  await p.engineStore.appendEntries(root.sessionId, first.id, [{
    id: "old-message", sessionId: root.sessionId, threadId: first.id, parentId: null,
    type: "message", role: "user", content: "Existing conversation", createdAt: 1,
  }]);
  const now = Date.now();
  const queueItemId = "legacy-approval-turn";
  await p.engineStore.admitSubmission(root.sessionId, pending.id, {
    id: queueItemId, threadId: pending.id, content: "Pending work", status: "queued",
    attemptCount: 0, maxAttempts: 10, timeoutAt: now + 600_000, createdAt: now, updatedAt: now,
  });
  const fence = { itemId: queueItemId, attemptId: "old-attempt", ownerId: "old-process" };
  await p.engineStore.claimSubmission({ sessionId: root.sessionId, threadId: pending.id, ...fence });
  const gate = {
    id: "legacy-approval", sessionId: root.sessionId, threadId: pending.id, queueItemId,
    resumeKey: "external-work", ordinal: 0, type: "approval" as const, title: "Approve existing work?",
    actions: [{ id: "approve", label: "Approve" }], status: "pending" as const, createdAt: now, updatedAt: now,
  };
  await p.engineStore.saveDecisionGate(root.sessionId, pending.id, gate);
  await p.engineStore.saveSuspendedTurn(root.sessionId, pending.id, {
    sessionId: root.sessionId, threadId: pending.id, queueItemId, gateId: gate.id,
    model: "anthropic/claude-haiku-4-5", toolCallId: "old-call", toolName: "external-work",
    toolArgs: {}, resumeKey: gate.resumeKey, ordinal: 0, attempt: 1, createdAt: now,
  }, fence);
  await p.engineStore.setSubmissionBlocked(root.sessionId, pending.id, queueItemId, true, fence);

  for (let restart = 0; restart < 2; restart++) {
    p.engineHost.evictCache(root.sessionId);
    const continued = await ensureAssistantExecution(p, owner, meta, first.key);
    expect(continued.sessionId).toBe(root.sessionId);
    expect(continued.session.options.readOnlyReason).toBeUndefined();
    expect(continued.session.options.workspace).toBe(directory);
    expect(continued.session.options.sandbox).toMatchObject({ workspace: directory });
    expect(continued.session.thread(first.key).id).toBe(first.id);
    expect(execFileSync(process.execPath, ["dashboard.cjs"], { cwd: continued.session.options.workspace, encoding: "utf8" })).toBe("existing recruiting data");
    expect(await readFile(join(directory, "dashboard.cjs"), "utf8")).toBe(script);
    expect(await p.engineStore.getEntries(root.sessionId, first.id)).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: "old-message", content: "Existing conversation" }),
    ]));
    expect(await p.engineStore.getQueueItem(root.sessionId, queueItemId)).toMatchObject({ status: "blocked_on_decision_gate" });
    expect(await p.engineStore.getDecisionGate(root.sessionId, gate.id)).toMatchObject({ status: "pending" });
    const detail = await fetch(`${api.baseUrl}/api/sessions/${encodeURIComponent(root.sessionId)}`);
    expect(detail.status).toBe(200);
    expect(await detail.json()).not.toHaveProperty("readOnlyReason");
    const credential = await fetch(`${api.baseUrl}/api/sessions/${encodeURIComponent(root.sessionId)}/sandbox-jwt`, {
      method: "POST", headers: { "x-valet-test-user-id": "test-member" },
    });
    expect(credential.status).toBe(200);
    // Use the engine resolver seam to continue the real persisted turn without a live provider.
    continued.session.options.resolveModel = async () => ({ model: faux.getModel(), apiKey: "test" });
    const sent = await fetch(`${api.baseUrl}/api/threads/${first.id}/messages`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ text: "Continue" }),
    });
    expect(sent.status).toBe(202);
    const receipt: unknown = await sent.json();
    if (!receipt || typeof receipt !== "object" || !("messageId" in receipt) || typeof receipt.messageId !== "string") throw new Error("Missing prompt receipt");
    const admittedId = receipt.messageId;
    await vi.waitFor(async () => expect(await p.engineStore.getQueueItem(root.sessionId, admittedId))
      .toMatchObject({ status: "settled", outcome: { outcome: "completed" } }));
    expect(await p.engineStore.getEntries(root.sessionId, first.id)).toEqual(expect.arrayContaining([
      expect.objectContaining({ role: "assistant", content: restart === 0 ? "Continued old chat" : "Continued again" }),
    ]));
  }
  const fresh = await ensureAssistantExecution(p, owner, meta, "web:new-chat");
  expect(fresh.sessionId).not.toBe(root.sessionId);
  expect(fresh.session.options.workspace).not.toBe(directory);
});


it("restores a workflow node on its recorded working directory", async () => {
  api = await bootTestApi();
  directory = await mkdtemp(join(tmpdir(), "valet-legacy-workflow-"));
  await writeFile(join(directory, "input.txt"), "retained workflow input");
  await writeFile(join(directory, "task.cjs"), 'process.stdout.write(require("node:fs").readFileSync("input.txt", "utf8"));');
  const options = { owner: { type: "user", id: "local-user" } as const, actorUserId: "local-user", orgId: "local-org", workspace: directory };
  const original = await api.providers.engineHost.workflowSessionFor("wf:legacy-run:node", options);
  const originalThread = await original.ensureDefaultThread();
  for (let restart = 0; restart < 2; restart++) {
    api.providers.engineHost.evictCache(original.id);
    const restored = await api.providers.engineHost.workflowSessionFor(original.id, { ...options, workspace: join(directory, "new-layout") });
    expect(restored.options.workspace).toBe(directory);
    expect(restored.options.sandbox).toMatchObject({ workspace: directory });
    expect((await restored.ensureDefaultThread()).id).toBe(originalThread.id);
    expect(execFileSync(process.execPath, ["task.cjs"], { cwd: restored.options.workspace, encoding: "utf8" })).toBe("retained workflow input");
  }
});
