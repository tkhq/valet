/**
 * Workflow and child posts use the carried-over profile (`assistants/
 * legacy-profile.ts`) only of the assistant they belong to. The singleton
 * cutover kept a team's extra assistants running under tombstone owners, so
 * a post that reads "the team's assistant" could take the surviving
 * assistant's name and avatar. A post that cannot be tied to one assistant
 * uses the team name instead while such an assistant runs.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Type } from "typebox";
import { eq, sql } from "drizzle-orm";
import type { ActionPlugin, PluginAction, Principal, Session } from "@valet/engine";
import { bootTestApi, type TestApi } from "../integration/_setup.js";
import { buildWorkflowEngineDeps } from "./engine-deps.js";
import { ensureDefaultAssistantSession } from "../assistants/service.js";
import { assistants, legacyAssistantRuntimes, legacyWorkflowRuntimes, teamMembers, teams, workflowDefinitions } from "../schema/index.js";

const ORG = "local-org";
const USER = "local-user";
const DESK = { displayName: "Desk Helper", avatarUrl: "https://valet.example/desk.png" };
const NIGHT = { displayName: "Night Helper", avatarUrl: "https://valet.example/night.png" };

const identity: PluginAction = {
  id: "demo.identity", name: "identity", description: "Read sender", riskLevel: "low", parameters: Type.Object({}),
  execute: async (_args, ctx) => ({ success: true, data: await ctx.resolveOutboundSender?.() }),
};
const demo: ActionPlugin = { service: "demo", actions: [identity] };

async function senderOf(session: Session) {
  return session.options.resolveOutboundSender?.();
}

describe("carried-over sender for workflow and child posts", () => {
  let api: TestApi;
  let retained: Awaited<ReturnType<typeof ensureDefaultAssistantSession>>;
  let survivor: Awaited<ReturnType<typeof ensureDefaultAssistantSession>>;
  const team: Principal = { type: "team", id: "retained-wf-team" };
  const meta = { orgId: ORG, actorUserId: USER };

  const deps = () => {
    const { db, engineHost, engineStore, workflowStore, actionPluginByService, engineCredentials } = api.providers;
    return buildWorkflowEngineDeps({ host: engineHost, store: workflowStore, db, engineStore, actionPluginByService, credentials: engineCredentials });
  };

  async function seedTeamRun(owner: Principal, runId: string, workflowId: string, legacySessionId?: string): Promise<void> {
    const { db, workflowStore } = api.providers;
    const now = Date.now();
    await db.insert(workflowDefinitions).values({ id: workflowId, orgId: ORG, ownerType: owner.type, ownerId: owner.id,
      name: workflowId, definition: { version: "dag/v1", nodes: [], edges: [] }, createdAt: now, updatedAt: now });
    if (legacySessionId) await db.insert(legacyWorkflowRuntimes).values({ workflowId, sessionId: legacySessionId, orgId: ORG });
    await workflowStore.createRun(runId, { workflowId, definitionVersionId: "v1" }, { version: "dag/v1", nodes: [], edges: [] },
      "v1", { ownerType: owner.type, ownerId: owner.id });
  }

  const invoke = (runId: string) =>
    deps().invokeAction({ service: "demo", action: "identity", params: {}, invocationId: `workflow:${runId}:identity` });

  async function workflowSessionSender(runId: string) {
    const sessionId = `wf:${runId}:session`;
    await deps().prompt(sessionId, "read sender", { dispatchId: `workflow:${runId}:session` });
    const session = api.providers.engineHost.liveSession(sessionId);
    if (!session) throw new Error(`no live workflow session ${sessionId}`);
    return senderOf(session);
  }

  beforeAll(async () => {
    api = await bootTestApi({ plugins: [{ name: "demo", version: "1", actions: [demo] }] });
    const { db, engineHost } = api.providers;
    await db.execute(sql`ALTER TABLE assistants ADD COLUMN IF NOT EXISTS name text,
      ADD COLUMN IF NOT EXISTS avatar_url text, ADD COLUMN IF NOT EXISTS personality text`);
    await db.insert(teams).values({ id: team.id, orgId: ORG, name: "Retained", createdAt: 1 });
    await db.insert(teamMembers).values({ teamId: team.id, userId: USER, role: "admin" });
    // The singleton cutover keeps one live row and moves the other to a
    // tombstone owner, while legacy_assistant_runtimes keeps it running.
    retained = await ensureDefaultAssistantSession(api.providers, team, meta);
    await db.insert(legacyAssistantRuntimes).values({ assistantId: retained.assistant.id, sessionId: retained.sessionId,
      orgId: ORG, ownerType: "team", ownerId: team.id });
    await db.update(assistants).set({ ownerId: `${team.id}:retired:${retained.assistant.id}`, archivedAt: 123 })
      .where(eq(assistants.id, retained.assistant.id));
    engineHost.evictCache(retained.sessionId);
    survivor = await ensureDefaultAssistantSession(api.providers, team, meta);
    // The upgrade snapshots every live assistant, the survivor included.
    await db.insert(legacyAssistantRuntimes).values({ assistantId: survivor.assistant.id, sessionId: survivor.sessionId,
      orgId: ORG, ownerType: "team", ownerId: team.id });
    await db.execute(sql`UPDATE assistants SET name = ${DESK.displayName}, avatar_url = ${DESK.avatarUrl} WHERE id = ${survivor.assistant.id}`);
    await db.execute(sql`UPDATE assistants SET name = ${NIGHT.displayName}, avatar_url = ${NIGHT.avatarUrl} WHERE id = ${retained.assistant.id}`);
  });

  afterAll(async () => {
    await api?.cleanup();
  });

  it("posts a retained assistant's workflow under that assistant's own profile", async () => {
    await seedTeamRun(team, "run-retained", "wf-retained", retained.sessionId);
    expect(await invoke("run-retained")).toEqual({ ok: true, result: NIGHT });
    expect(await workflowSessionSender("run-retained")).toEqual(NIGHT);
  });

  it("posts the surviving assistant's own workflow under its profile", async () => {
    await seedTeamRun(team, "run-survivor", "wf-survivor", survivor.sessionId);
    expect(await invoke("run-survivor")).toEqual({ ok: true, result: DESK });
  });

  it("uses the team name for a workflow no assistant claims while a retained one runs", async () => {
    await seedTeamRun(team, "run-unclaimed", "wf-unclaimed");
    expect(await invoke("run-unclaimed")).toEqual({ ok: true, result: { displayName: "Retained" } });
    expect(await workflowSessionSender("run-unclaimed")).toEqual({ displayName: "Retained" });
  });

  it("posts a child under its parent assistant's profile", async () => {
    const childOf = (parent: typeof retained, id: string) => api.providers.engineHost.childSessionFor(id, {
      parentSessionId: parent.sessionId, parentThreadId: "thread:parent", actorUserId: USER, orgId: ORG, owner: team, workspace: "/tmp",
    });
    expect(await senderOf(await childOf(retained, "child:retained"))).toEqual(NIGHT);
    expect(await senderOf(await childOf(survivor, "child:survivor"))).toEqual(DESK);
  });

  it("keeps the restored profile for a workspace with one assistant", async () => {
    const solo: Principal = { type: "team", id: "solo-wf-team" };
    const { db } = api.providers;
    await db.insert(teams).values({ id: solo.id, orgId: ORG, name: "Solo", createdAt: 1 });
    const only = await ensureDefaultAssistantSession(api.providers, solo, meta);
    await db.execute(sql`UPDATE assistants SET name = ${DESK.displayName} WHERE id = ${only.assistant.id}`);
    await seedTeamRun(solo, "run-solo", "wf-solo");
    expect(await invoke("run-solo")).toEqual({ ok: true, result: { displayName: DESK.displayName } });
  });

  it("falls back to the team name, never the survivor's, when the retained assistant has no profile", async () => {
    const { db } = api.providers;
    await db.execute(sql`UPDATE assistants SET name = NULL, avatar_url = NULL WHERE id = ${retained.assistant.id}`);
    await seedTeamRun(team, "run-retained-bare", "wf-retained-bare", retained.sessionId);
    expect(await invoke("run-retained-bare")).toEqual({ ok: true, result: { displayName: "Retained" } });
  });
});
