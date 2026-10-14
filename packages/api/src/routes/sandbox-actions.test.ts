/**
 * `POST /api/sandbox/actions/:toolId/invoke`: a workflow step's script calls
 * an integration as the step's run, through the same invoker and policy
 * rules as a `tool` node. Real app via `bootTestApi`, real sandbox tokens.
 */
import { Type } from "typebox";
import type { ValetPlugin } from "@valet/engine";
import { and, eq, like } from "drizzle-orm";
import { afterEach, describe, expect, it } from "vitest";
import { mintSandboxToken } from "../auth/sandbox-tokens.js";
import { bootTestApi, type TestApi } from "../integration/_setup.js";
import { createPolicy } from "../policies/admin.js";
import { actionInvocations, teamMembers, teams, workflowDefinitions } from "../schema/index.js";

let api: TestApi | undefined;

afterEach(async () => {
  await api?.cleanup();
  api = undefined;
});

const TEAM = "script-team";
const RUN = "wfrun_script";
const SESSION = `wf:${RUN}:fetch`;
let echoCalls = 0;

function plugins(): ValetPlugin[] {
  const echo = {
    id: "demo.echo", name: "Echo", description: "Echoes text and reports the credential it used.", riskLevel: "low" as const,
    parameters: Type.Object({ text: Type.Optional(Type.String()) }),
    execute: async (args: unknown, ctx: { credentials: { get: () => Promise<{ accessToken: string } | null> } }) => {
      echoCalls += 1;
      const credential = await ctx.credentials.get();
      const text = typeof args === "object" && args !== null && "text" in args && typeof args.text === "string" ? args.text : null;
      return { success: true, data: { text, credential: credential?.accessToken ?? null } };
    },
  };
  return [
    { name: "demo", version: "0.0.1", actions: [{ service: "demo", actions: [echo] }],
      credentials: [{ service: "demo", type: "api_key", configKeys: ["apiKey"], connectLabel: "Demo" }] },
    { name: "remote", version: "0.0.1", actions: [{ service: "remote", actions: [], resolveActions: async () => [
      { id: "remote.lookup", name: "Lookup", description: "A tool discovered at run time.", riskLevel: "low", parameters: Type.Object({}), execute: async () => ({ success: true, data: { found: true } }) },
    ] }] },
  ];
}

async function seed(): Promise<string> {
  api = await bootTestApi({ plugins: plugins() });
  const p = api.providers;
  const now = Date.now();
  await p.db.insert(teams).values({ id: TEAM, orgId: "local-org", name: "Script team", createdAt: now });
  await p.db.insert(teamMembers).values({ teamId: TEAM, userId: "local-user", role: "member" });
  await p.db.insert(workflowDefinitions).values({ id: "wf_script", orgId: "local-org", ownerType: "team", ownerId: TEAM, name: "Script", definition: {}, createdAt: now, updatedAt: now });
  await p.workflowStore.createRun(RUN, { workflowId: "wf_script", definitionVersionId: "v1" },
    { version: "dag/v1", nodes: [], edges: [] }, "v1", { ownerType: "team", ownerId: TEAM, actorUserId: "local-user" });
  await p.workflowStore.claimRun(RUN, "host", 30_000);
  echoCalls = 0;
  // The member who started the run has an account too; the call must use the team's.
  await p.engineCredentials.save({ type: "team", id: TEAM }, "demo", { type: "api_key", apiKey: "team-key" });
  await p.engineCredentials.save({ type: "user", id: "local-user" }, "demo", { type: "api_key", apiKey: "member-key" });
  return (await mintSandboxToken(p.db, { sessionId: SESSION, userId: "local-user", orgId: "local-org" })).token;
}

function invoke(token: string, toolId: string, params: Record<string, unknown> = {}, idempotencyKey?: string): Promise<Response> {
  return fetch(`${api!.baseUrl}/api/sandbox/actions/${toolId}/invoke`, {
    method: "POST", headers: { "Content-Type": "application/json", "x-valet-sandbox": token },
    body: JSON.stringify({ params, ...(idempotencyKey ? { idempotencyKey } : {}) }),
  });
}

describe("POST /api/sandbox/actions/:toolId/invoke", () => {
  it("runs as the workflow run's owner, finds dynamic tools, and writes the Action Log row", async () => {
    const token = await seed();
    const res = await invoke(token, "demo.echo", { text: "hi" });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ tool_id: "demo.echo", status: "completed", result: { text: "hi", credential: "team-key" } });

    const dynamic = await invoke(token, "remote.lookup");
    expect(await dynamic.json()).toMatchObject({ status: "completed", result: { found: true } });

    // The broker's external audit row, one per call.
    const rows = await api!.providers.db.select().from(actionInvocations)
      .where(and(eq(actionInvocations.actionId, "demo.echo"), like(actionInvocations.invocationId, "pol:ext:%")));
    expect(rows).toHaveLength(1);
  });

  it("applies the session-scoped policy the step's agent has, so a script cannot get around it", async () => {
    const token = await seed();
    await createPolicy(api!.providers.db, { orgId: "local-org", type: "org", id: "local-org" },
      { actionId: "demo.echo", mode: "deny", appliesIn: "session", managedBy: "local-user", now: Date.now() });
    const denied = await invoke(token, "demo.echo");
    expect(await denied.json()).toMatchObject({ status: "failed" });
    expect(echoCalls).toBe(0);
  });

  it("refuses a run that has finished", async () => {
    const token = await seed();
    await api!.providers.workflowStore.settleRun(RUN, "cancelled");
    const res = await invoke(token, "demo.echo");
    expect(res.status).toBe(409);
    expect(echoCalls).toBe(0);
  });

  it("runs a call with a repeated idempotencyKey once", async () => {
    const token = await seed();
    const first = await (await invoke(token, "demo.echo", { text: "once" }, "k1")).json();
    const second = await (await invoke(token, "demo.echo", { text: "once" }, "k1")).json();
    expect(second).toEqual(first);
    expect(echoCalls).toBe(1);
    await invoke(token, "demo.echo", { text: "other params" }, "k1");
    expect(echoCalls).toBe(2);
  });

  it("refuses a session that is not a workflow step", async () => {
    await seed();
    const { token } = await mintSandboxToken(api!.providers.db, { sessionId: "sess_interactive", userId: "local-user", orgId: "local-org" });
    const res = await invoke(token, "demo.echo");
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: "Only a workflow step can call actions from its sandbox. Ask the agent to call the tool instead." });
  });

  it("refuses Valet's own services and an action that policy holds for approval", async () => {
    const token = await seed();
    expect((await invoke(token, "workflows.list_workflows")).status).toBe(403);

    await createPolicy(api!.providers.db, { orgId: "local-org", type: "org", id: "local-org" },
      { actionId: "demo.echo", mode: "require_approval", managedBy: "local-user", now: Date.now() });
    const held = await invoke(token, "demo.echo");
    expect(held.status).toBe(403);
    expect(await held.json()).toMatchObject({ status: "approval_required" });
  });
});
