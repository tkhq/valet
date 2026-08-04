/**
 * `POST /api/hooks/workflows/:workflowId/:hookId` — public ingress
 * (overhaul design decision 5). Mounted before `buildAuthMiddleware` in
 * app.ts, so these requests carry NO auth header on purpose: that's the
 * behavior under test.
 */
import { describe, it, expect, afterEach } from "vitest";
import { eq } from "drizzle-orm";
import type { RunHost } from "@valet/workflow";
import { bootTestApi, type TestApi } from "../integration/_setup.js";
import { workflowWebhooks } from "../schema/index.js";
import type { CreateWorkflowResponse } from "../wire/types.js";

let api: TestApi | undefined;

afterEach(async () => {
  await api?.cleanup();
  api = undefined;
});

const VALID_DEFINITION = {
  version: "dag/v1",
  nodes: [
    { id: "trigger", type: "trigger" },
    { id: "stop", type: "stop" },
  ],
  edges: [{ from: "trigger", to: "stop" }],
};

class StubRunHost implements RunHost {
  started: Array<{ runId: string; params: unknown; owner?: { ownerType: string; ownerId: string } }> = [];
  async start(
    runId: string,
    params: unknown,
    _definition: unknown,
    owner?: { ownerType: string; ownerId: string },
  ): Promise<void> {
    this.started.push({ runId, params, owner });
  }
  async wake(): Promise<void> {}
  async scheduleWake(): Promise<void> {}
  async terminate(): Promise<void> {}
  startHost(): void {}
  async stopHost(): Promise<void> {}
}

async function createWorkflow(baseUrl: string): Promise<CreateWorkflowResponse> {
  const res = await fetch(`${baseUrl}/api/workflows`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name: "hook-target", definition: VALID_DEFINITION }),
  });
  expect(res.status).toBe(201);
  return (await res.json()) as CreateWorkflowResponse;
}

async function mintHook(baseUrl: string, workflowId: string): Promise<string> {
  const res = await fetch(`${baseUrl}/api/workflows/${workflowId}/webhook`, { method: "POST" });
  expect(res.status).toBe(200);
  const body = (await res.json()) as { hookId: string };
  return body.hookId;
}

describe("POST /api/hooks/workflows/:workflowId/:hookId", () => {
  it("starts a run with no auth header when the hookId is correct", async () => {
    const runHost = new StubRunHost();
    api = await bootTestApi({ workflowRunHost: runHost });
    const wf = await createWorkflow(api.baseUrl);
    const hookId = await mintHook(api.baseUrl, wf.id);

    const res = await fetch(`${api.baseUrl}/api/hooks/workflows/${wf.id}/${hookId}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ foo: "bar" }),
    });

    expect(res.status).toBe(202);
    const body = (await res.json()) as { runId: string };
    expect(body.runId).toMatch(/^wfrun_/);
    expect(runHost.started).toHaveLength(1);
    expect(runHost.started[0]!.runId).toBe(body.runId);
  });

  it("delivers the JSON body as trigger data", async () => {
    const runHost = new StubRunHost();
    api = await bootTestApi({ workflowRunHost: runHost });
    const wf = await createWorkflow(api.baseUrl);
    const hookId = await mintHook(api.baseUrl, wf.id);

    await fetch(`${api.baseUrl}/api/hooks/workflows/${wf.id}/${hookId}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ example: 42 }),
    });

    const params = runHost.started[0]!.params as { input: { type: string; data: Record<string, unknown> } };
    expect(params.input.type).toBe("webhook");
    expect(params.input.data).toEqual({ example: 42 });
  });

  it("starts the run owned by the workflow's own owner, not a caller-supplied one", async () => {
    const runHost = new StubRunHost();
    api = await bootTestApi({ workflowRunHost: runHost });
    const wf = await createWorkflow(api.baseUrl);
    const hookId = await mintHook(api.baseUrl, wf.id);

    await fetch(`${api.baseUrl}/api/hooks/workflows/${wf.id}/${hookId}`, { method: "POST" });

    expect(runHost.started[0]!.owner).toEqual({ ownerType: "user", ownerId: "local-user" });
  });

  it("accepts an empty body", async () => {
    const runHost = new StubRunHost();
    api = await bootTestApi({ workflowRunHost: runHost });
    const wf = await createWorkflow(api.baseUrl);
    const hookId = await mintHook(api.baseUrl, wf.id);

    const res = await fetch(`${api.baseUrl}/api/hooks/workflows/${wf.id}/${hookId}`, { method: "POST" });
    expect(res.status).toBe(202);
  });

  it("404s on a wrong hookId without starting a run, with the SAME body shape as an unknown workflowId (no oracle)", async () => {
    const runHost = new StubRunHost();
    api = await bootTestApi({ workflowRunHost: runHost });
    const wf = await createWorkflow(api.baseUrl);
    await mintHook(api.baseUrl, wf.id);

    const res = await fetch(`${api.baseUrl}/api/hooks/workflows/${wf.id}/${"0".repeat(64)}`, { method: "POST" });
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("not found");
    expect(runHost.started).toHaveLength(0);
  });

  it("404s on an unknown workflowId with the same shape as a wrong hookId (no oracle)", async () => {
    const runHost = new StubRunHost();
    api = await bootTestApi({ workflowRunHost: runHost });

    const knownWrong = await fetch(`${api.baseUrl}/api/hooks/workflows/wf_missing/${"0".repeat(64)}`, {
      method: "POST",
    });
    expect(knownWrong.status).toBe(404);
    const body = (await knownWrong.json()) as { error: string };
    expect(body.error).toBe("not found");
  });

  it("404s when no hook has been minted for the workflow", async () => {
    const runHost = new StubRunHost();
    api = await bootTestApi({ workflowRunHost: runHost });
    const wf = await createWorkflow(api.baseUrl);

    const res = await fetch(`${api.baseUrl}/api/hooks/workflows/${wf.id}/${"0".repeat(64)}`, { method: "POST" });
    expect(res.status).toBe(404);
  });

  it("413s a body over the 64KB cap without starting a run", async () => {
    const runHost = new StubRunHost();
    api = await bootTestApi({ workflowRunHost: runHost });
    const wf = await createWorkflow(api.baseUrl);
    const hookId = await mintHook(api.baseUrl, wf.id);

    const big = JSON.stringify({ data: "x".repeat(70_000) });
    const res = await fetch(`${api.baseUrl}/api/hooks/workflows/${wf.id}/${hookId}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "Content-Length": String(Buffer.byteLength(big)) },
      body: big,
    });
    expect(res.status).toBe(413);
    expect(runHost.started).toHaveLength(0);
  });

  it("400s on an invalid JSON body", async () => {
    const runHost = new StubRunHost();
    api = await bootTestApi({ workflowRunHost: runHost });
    const wf = await createWorkflow(api.baseUrl);
    const hookId = await mintHook(api.baseUrl, wf.id);

    const res = await fetch(`${api.baseUrl}/api/hooks/workflows/${wf.id}/${hookId}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{not json",
    });
    expect(res.status).toBe(400);
  });

  it("429s once the per-workflow rate limit is exceeded", async () => {
    const runHost = new StubRunHost();
    // A tiny limit makes this deterministic without racing a wall-clock window.
    api = await bootTestApi({ workflowRunHost: runHost, webhookRateLimit: { limit: 2, windowMs: 60_000 } });
    const baseUrl = api.baseUrl;
    const wf = await createWorkflow(baseUrl);
    const hookId = await mintHook(baseUrl, wf.id);

    const fire = () => fetch(`${baseUrl}/api/hooks/workflows/${wf.id}/${hookId}`, { method: "POST" });
    expect((await fire()).status).toBe(202);
    expect((await fire()).status).toBe(202);
    expect((await fire()).status).toBe(429);
    expect(runHost.started).toHaveLength(2);
  });

  it("rate-limits wrong-hookId guesses too (brute-force resistance) — the limiter guards the secret, not just success", async () => {
    const runHost = new StubRunHost();
    api = await bootTestApi({ workflowRunHost: runHost, webhookRateLimit: { limit: 2, windowMs: 60_000 } });
    const baseUrl = api.baseUrl;
    const wf = await createWorkflow(baseUrl);
    await mintHook(baseUrl, wf.id);

    const guess = () => fetch(`${baseUrl}/api/hooks/workflows/${wf.id}/${"1".repeat(64)}`, { method: "POST" });
    expect((await guess()).status).toBe(404);
    expect((await guess()).status).toBe(404);
    expect((await guess()).status).toBe(429);
  });

  it("rate-limits each workflow independently", async () => {
    const runHost = new StubRunHost();
    api = await bootTestApi({ workflowRunHost: runHost, webhookRateLimit: { limit: 1, windowMs: 60_000 } });
    const baseUrl = api.baseUrl;
    const wfA = await createWorkflow(baseUrl);
    const hookA = await mintHook(baseUrl, wfA.id);
    const wfB = await createWorkflow(baseUrl);
    const hookB = await mintHook(baseUrl, wfB.id);

    const fireA = () => fetch(`${baseUrl}/api/hooks/workflows/${wfA.id}/${hookA}`, { method: "POST" });
    const fireB = () => fetch(`${baseUrl}/api/hooks/workflows/${wfB.id}/${hookB}`, { method: "POST" });
    expect((await fireA()).status).toBe(202);
    expect((await fireA()).status).toBe(429);
    expect((await fireB()).status).toBe(202);
  });
});

describe("Idempotency-Key header", () => {
  it("the same key on the same workflow produces the same runId (retry-safe)", async () => {
    const runHost = new StubRunHost();
    api = await bootTestApi({ workflowRunHost: runHost });
    const wf = await createWorkflow(api.baseUrl);
    const hookId = await mintHook(api.baseUrl, wf.id);

    const post = () =>
      fetch(`${api!.baseUrl}/api/hooks/workflows/${wf.id}/${hookId}`, {
        method: "POST",
        headers: { "Idempotency-Key": "delivery-abc-123" },
      });
    const first = (await (await post()).json()) as { runId: string };
    const second = (await (await post()).json()) as { runId: string };
    expect(second.runId).toBe(first.runId);
  });

  it("different keys (or no key) produce different runIds", async () => {
    const runHost = new StubRunHost();
    api = await bootTestApi({ workflowRunHost: runHost });
    const wf = await createWorkflow(api.baseUrl);
    const hookId = await mintHook(api.baseUrl, wf.id);
    const url = `${api.baseUrl}/api/hooks/workflows/${wf.id}/${hookId}`;

    const withKey = (key: string) =>
      fetch(url, { method: "POST", headers: { "Idempotency-Key": key } }).then((r) => r.json()) as Promise<{
        runId: string;
      }>;
    const noKey = () => fetch(url, { method: "POST" }).then((r) => r.json()) as Promise<{ runId: string }>;

    const a = await withKey("key-a");
    const b = await withKey("key-b");
    const c = await noKey();
    const d = await noKey();
    const ids = [a.runId, b.runId, c.runId, d.runId];
    expect(new Set(ids).size).toBe(4);
  });

  it("the same key on a DIFFERENT workflow produces a different runId (scoped, not global)", async () => {
    const runHost = new StubRunHost();
    api = await bootTestApi({ workflowRunHost: runHost });
    const wfA = await createWorkflow(api.baseUrl);
    const hookA = await mintHook(api.baseUrl, wfA.id);
    const wfB = await createWorkflow(api.baseUrl);
    const hookB = await mintHook(api.baseUrl, wfB.id);

    const post = (workflowId: string, hookId: string) =>
      fetch(`${api!.baseUrl}/api/hooks/workflows/${workflowId}/${hookId}`, {
        method: "POST",
        headers: { "Idempotency-Key": "same-key" },
      }).then((r) => r.json()) as Promise<{ runId: string }>;

    const a = await post(wfA.id, hookA);
    const b = await post(wfB.id, hookB);
    expect(a.runId).not.toBe(b.runId);
  });
});

describe("webhook cleanup on workflow deletion", () => {
  it("removes the workflow_webhooks row through the real DELETE /api/workflows/:id route (no orphaned secret)", async () => {
    const runHost = new StubRunHost();
    api = await bootTestApi({ workflowRunHost: runHost });
    const baseUrl = api.baseUrl;
    const wf = await createWorkflow(baseUrl);
    const hookId = await mintHook(baseUrl, wf.id);

    const del = await fetch(`${baseUrl}/api/workflows/${wf.id}`, { method: "DELETE" });
    expect(del.status).toBe(200);

    const rows = await api.providers.db
      .select()
      .from(workflowWebhooks)
      .where(eq(workflowWebhooks.workflowId, wf.id));
    expect(rows).toHaveLength(0);

    const res = await fetch(`${baseUrl}/api/hooks/workflows/${wf.id}/${hookId}`, { method: "POST" });
    expect(res.status).toBe(404);
    expect(runHost.started).toHaveLength(0);
  });
});
