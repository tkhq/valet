import { afterEach, expect, it } from "vitest";
import { THREAD_PLAN_KEY } from "@valet/engine";
import { bootTestApi, type TestApi } from "../integration/_setup.js";
import { planProgress } from "../services/thread-plan.js";
import type { ThreadPlan, ThreadPlanResponse } from "../wire/types.js";

let api: TestApi | undefined;
afterEach(async () => { await api?.cleanup(); api = undefined; });

it("reads a thread's plan with the thread's access checks", async () => {
  api = await bootTestApi();
  const created = await fetch(`${api.baseUrl}/api/threads`, { method: "POST" });
  expect(created.status).toBe(201);
  const thread = await created.json() as { id: string; sessionId: string };
  const read = async (headers?: Record<string, string>) => {
    const response = await fetch(`${api!.baseUrl}/api/threads/${thread.id}/plan`, { headers });
    return { status: response.status, body: await response.json() as ThreadPlanResponse };
  };
  const writeMetadata = async (value: unknown) => {
    const stored = await api!.providers.engineStore.getThread(thread.sessionId, thread.id);
    if (!stored) throw new Error("Missing thread");
    await api!.providers.engineStore.saveThread(thread.sessionId, { ...stored, metadata: { ...stored.metadata, [THREAD_PLAN_KEY]: value } });
  };

  expect(await read()).toEqual({ status: 200, body: { plan: null } });

  const plan: ThreadPlan = {
    items: [{ text: "Read the logs", status: "done" }, { text: "Fix the retry", status: "in_progress" }, { text: "Ship it", status: "pending" }],
    updatedAt: 1_700_000_000_000,
  };
  await writeMetadata(plan);
  expect(await read()).toEqual({ status: 200, body: { plan } });
  expect(planProgress(plan)).toEqual({ done: 1, total: 3, current: "Fix the retry" });

  await writeMetadata({ items: "not a list", updatedAt: 1 });
  expect(await read()).toEqual({ status: 200, body: { plan: null } });

  expect((await read({ "x-valet-test-user-id": "test-member" })).status).toBe(404);
  expect((await fetch(`${api.baseUrl}/api/threads/th-missing/plan`)).status).toBe(404);
});
