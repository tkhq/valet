// A workflow permission card names the person who asked as its approver
// (`workflows.allow_permissions`). A team API key records its minting admin
// as the resolver, so without the approver it could answer that admin's card.
import { afterEach, expect, it } from "vitest";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { bootTestApi, type TestApi } from "../integration/_setup.js";
import type { CreateTeamApiKeyResponse, CreateTeamResponse, SessionDetail } from "../wire/types.js";

let api: TestApi | undefined;
afterEach(async () => { await api?.cleanup(); api = undefined; });

it("refuses a team API key on a workflow permission card and accepts the person who asked", async () => {
  api = await bootTestApi({ auth: true });
  const signUp = await fetch(`${api.baseUrl}/api/auth/sign-up/email`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name: "Admin", email: "admin@nowhere.test", password: "correct-horse-battery" }),
  });
  const cookie = signUp.headers.get("set-cookie")?.match(/better-auth\.session_token=[^;]+/)?.[0];
  if (!cookie) throw new Error("Missing session cookie.");
  const adminId = ((await signUp.json()) as { user: { id: string } }).user.id;
  const team = await (await fetch(`${api.baseUrl}/api/teams`, { method: "POST", headers: { "content-type": "application/json", cookie }, body: JSON.stringify({ name: "Platform" }) })).json() as CreateTeamResponse;
  const teamKey = ((await (await fetch(`${api.baseUrl}/api/teams/${team.team.id}/api-keys`, { method: "POST", headers: { "content-type": "application/json", cookie }, body: JSON.stringify({ name: "CI" }) })).json()) as CreateTeamApiKeyResponse).key;
  const workspace = await mkdtemp(join(tmpdir(), "valet-card-"));
  const session = await (await fetch(`${api.baseUrl}/api/sessions`, { method: "POST", headers: { "content-type": "application/json", "x-api-key": teamKey }, body: JSON.stringify({ workspace }) })).json() as SessionDetail;
  const created = (await (await fetch(`${api.baseUrl}/api/sessions/${session.id}/threads`, { method: "POST", headers: { "content-type": "application/json", cookie }, body: "{}" })).json()) as { id: string };
  await api.providers.engineStore.saveDecisionGate(session.id, created.id, {
    id: "allow-perms", sessionId: session.id, threadId: created.id, queueItemId: "q", resumeKey: "workflow-permissions:wf_x:abc", ordinal: 0,
    type: "approval", title: "Allow \"Weekly digest\" to run without asking?", actions: [{ id: "approve", label: "Allow" }, { id: "cancel", label: "Not now" }],
    context: { approver: { userId: adminId } }, status: "pending", createdAt: 1, updatedAt: 1,
  });
  const resolve = (headers: Record<string, string>) => fetch(`${api!.baseUrl}/api/sessions/${session.id}/decisions/allow-perms/resolve`, {
    method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify({ actionId: "approve" }),
  });
  expect((await resolve({ "x-api-key": teamKey })).status).toBe(403);
  expect((await api.providers.engineStore.getDecisionGate(session.id, "allow-perms"))?.status).toBe("pending");
  expect((await resolve({ cookie })).status).toBe(200);
});
