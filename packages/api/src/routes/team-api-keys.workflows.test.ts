/**
 * A team `vlt_` key reaches its team's workflows and their triggers, and
 * nothing the creating admin owns personally (TKAI-396 done-when 5). The
 * trigger and preview routes build a `WorkflowOwner`; one that carries no
 * principal falls back to the user rule and hands the key the admin's
 * personal rows.
 */
import { describe, expect, it, afterEach } from "vitest";
import { bootTestApi, type TestApi } from "../integration/_setup.js";
import type {
  CreateTeamApiKeyResponse,
  CreateTeamResponse,
  CreateWorkflowResponse,
  ListWorkflowTriggersResponse,
  WorkflowScheduleResponse,
} from "../wire/types.js";

let api: TestApi | undefined;

afterEach(async () => {
  await api?.cleanup();
  api = undefined;
});

const DEFINITION = {
  version: "dag/v1",
  nodes: [
    { id: "trigger", type: "trigger" },
    { id: "stop", type: "stop" },
  ],
  edges: [{ from: "trigger", to: "stop" }],
};

function extractSessionCookie(setCookieHeader: string | null): string {
  expect(setCookieHeader).toBeTruthy();
  const match = setCookieHeader?.match(/better-auth\.session_token=[^;]+/);
  expect(match).toBeTruthy();
  return match![0];
}

async function signUp(baseUrl: string, email: string, name: string): Promise<string> {
  const res = await fetch(`${baseUrl}/api/auth/sign-up/email`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name, email, password: "correct-horse-battery" }),
  });
  expect(res.status).toBe(200);
  return extractSessionCookie(res.headers.get("set-cookie"));
}

async function createTeam(baseUrl: string, cookie: string, name: string): Promise<string> {
  const res = await fetch(`${baseUrl}/api/teams`, {
    method: "POST",
    headers: { "content-type": "application/json", cookie },
    body: JSON.stringify({ name }),
  });
  expect(res.status).toBe(201);
  return ((await res.json()) as CreateTeamResponse).team.id;
}

async function mintTeamKey(baseUrl: string, cookie: string, teamId: string): Promise<string> {
  const res = await fetch(`${baseUrl}/api/teams/${teamId}/api-keys`, {
    method: "POST",
    headers: { "content-type": "application/json", cookie },
    body: JSON.stringify({ name: "CI" }),
  });
  expect(res.status).toBe(201);
  return ((await res.json()) as CreateTeamApiKeyResponse).key;
}

async function createWorkflow(baseUrl: string, headers: Record<string, string>, name: string): Promise<string> {
  const res = await fetch(`${baseUrl}/api/workflows`, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify({ name, definition: DEFINITION }),
  });
  expect(res.status).toBe(201);
  return ((await res.json()) as CreateWorkflowResponse).id;
}

function createSchedule(baseUrl: string, headers: Record<string, string>, workflowId: string): Promise<Response> {
  return fetch(`${baseUrl}/api/workflows/schedules`, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify({ name: "daily", cron: "0 9 * * 1-5", target: { kind: "workflow", workflowId } }),
  });
}

interface Fixture {
  baseUrl: string;
  cookie: string;
  teamId: string;
  teamKey: string;
  personalWorkflowId: string;
  teamWorkflowId: string;
}

/** One admin, one team, one team key, a personal and a team workflow, and
 * a schedule on the personal one made by the admin. */
async function bootFixture(): Promise<Fixture> {
  api = await bootTestApi({ auth: true });
  const cookie = await signUp(api.baseUrl, "admin@nowhere.test", "First Admin");
  const teamId = await createTeam(api.baseUrl, cookie, "Platform");
  const teamKey = await mintTeamKey(api.baseUrl, cookie, teamId);
  const personalWorkflowId = await createWorkflow(api.baseUrl, { cookie }, "personal");
  const teamWorkflowId = await createWorkflow(api.baseUrl, { "x-api-key": teamKey }, "team");
  const scheduled = await createSchedule(api.baseUrl, { cookie }, personalWorkflowId);
  expect(scheduled.status).toBe(201);
  return { baseUrl: api.baseUrl, cookie, teamId, teamKey, personalWorkflowId, teamWorkflowId };
}

describe("team API key workflow reach", () => {
  it("lists only its team's triggers, never the admin's personal schedule", async () => {
    const f = await bootFixture();
    const headers = { "x-api-key": f.teamKey };

    const before = await fetch(`${f.baseUrl}/api/workflows/triggers`, { headers });
    expect(before.status).toBe(200);
    expect(((await before.json()) as ListWorkflowTriggersResponse).triggers).toEqual([]);

    const teamSchedule = await createSchedule(f.baseUrl, headers, f.teamWorkflowId);
    expect(teamSchedule.status).toBe(201);
    const created = (await teamSchedule.json()) as WorkflowScheduleResponse;

    const after = await fetch(`${f.baseUrl}/api/workflows/triggers`, { headers });
    const listed = ((await after.json()) as ListWorkflowTriggersResponse).triggers;
    expect(listed.map((t) => t.id)).toEqual([created.schedule.scheduleId]);
    expect(listed.every((t) => t.workflowId === f.teamWorkflowId)).toBe(true);
  });

  it("cannot schedule the admin's personal workflow", async () => {
    const f = await bootFixture();
    const res = await createSchedule(f.baseUrl, { "x-api-key": f.teamKey }, f.personalWorkflowId);
    // The schedule route answers every service refusal as 400; the body
    // carries the existence-hiding "not found", same as a cookie caller
    // who does not own the workflow gets.
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toContain("workflow not found");
  });

  it("previews its team's workflow and 404s the admin's personal one", async () => {
    const f = await bootFixture();
    const headers = { "content-type": "application/json", "x-api-key": f.teamKey };

    const personal = await fetch(`${f.baseUrl}/api/workflows/${f.personalWorkflowId}/preview`, {
      method: "POST",
      headers,
      body: JSON.stringify({ source: "none" }),
    });
    expect(personal.status).toBe(404);
    const team = await fetch(`${f.baseUrl}/api/workflows/${f.teamWorkflowId}/preview`, {
      method: "POST",
      headers,
      body: JSON.stringify({ source: "none" }),
    });
    expect(team.status).toBe(200);
  });
});
