/**
 * `/api/templates` route tests — the gallery's HTTP surface over a real
 * Hono app (`bootTestApi`), with a fixture plugin standing in for the
 * shipped ones so the assertions do not move when a template's copy does.
 *
 * The decisions themselves are tested in `../workflows/templates.test.ts`.
 * This file pins the contract the web client codes against: the response
 * shapes, and which refusal maps to which status.
 */
import { afterEach, describe, expect, it } from "vitest";
import { Type } from "typebox";
import type { ActionPlugin, PluginAction, ValetPlugin, WorkflowTemplate } from "@valet/engine";
import { bootTestApi, type TestApi } from "../integration/_setup.js";
import { builtinWorkflowTemplates } from "../workflows/template-definitions.js";
import { teamMembers, teams, workflowDefinitions, workflowSchedules } from "../schema/index.js";
import type {
  InstallWorkflowTemplateRequest,
  InstallWorkflowTemplateResponse,
  ListWorkflowTemplatesResponse,
  ListWorkflowsResponse,
} from "../wire/types.js";

let api: TestApi | undefined;

afterEach(async () => {
  await api?.cleanup();
  api = undefined;
});

function action(id: string): PluginAction {
  return {
    id,
    name: id,
    description: id,
    riskLevel: "low",
    parameters: Type.Object({}),
    execute: () => Promise.resolve({ success: true, data: {} }),
  };
}

const gmailActions: ActionPlugin = { service: "gmail", actions: [action("gmail.list_labels")] };
const notesActions: ActionPlugin = { service: "notes", actions: [action("notes.read")] };

function definition(nodes: unknown[], edges: unknown[]): unknown {
  return { version: "dag/v1", nodes, edges };
}

const gmailTemplate: WorkflowTemplate = {
  id: "gmail-sweep",
  name: "Inbox sweeper",
  description: "Moves low-priority mail onto one label.",
  category: "Inbox",
  apps: ["gmail"],
  steps: ["Read the labels"],
  definition: definition(
    [
      { id: "start", type: "trigger" },
      { id: "labels", type: "tool", service: "gmail", action: "list_labels", params: {} },
    ],
    [{ from: "start", to: "labels" }],
  ),
  schedule: { name: "Inbox sweeper", cron: "0 12 * * 1-5", timezone: "UTC", description: "Weekdays at 12:00" },
};

const notesTemplate: WorkflowTemplate = {
  id: "notes-echo",
  name: "Notes echo",
  description: "Reads one note.",
  category: "Batch work",
  apps: ["notes"],
  steps: ["Read"],
  definition: definition(
    [
      { id: "start", type: "trigger", dataSchema: { noteId: { type: "string", label: "Note id" } } },
      { id: "read", type: "tool", service: "notes", action: "read", params: { id: "{{ trigger.data.noteId }}" } },
    ],
    [{ from: "start", to: "read" }],
  ),
};

const fixturePlugins: ValetPlugin[] = [
  {
    name: "gmail",
    version: "0.0.1",
    actions: [gmailActions],
    credentials: [{ type: "oauth2", service: "gmail", configKeys: [] }],
    templates: [gmailTemplate],
  },
  { name: "notes", version: "0.0.1", actions: [notesActions], templates: [notesTemplate] },
];

async function boot(): Promise<TestApi> {
  api = await bootTestApi({ plugins: fixturePlugins });
  return api;
}

async function install(
  baseUrl: string,
  id: string,
  body?: InstallWorkflowTemplateRequest | string,
): Promise<Response> {
  return fetch(`${baseUrl}/api/templates/${encodeURIComponent(id)}/install`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    ...(body === undefined ? {} : { body: typeof body === "string" ? body : JSON.stringify(body) }),
  });
}

describe("GET /api/templates", () => {
  it("lists every template with the caller's own connection state", async () => {
    const a = await boot();
    const res = await fetch(`${a.baseUrl}/api/templates`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as ListWorkflowTemplatesResponse;

    // The listing also carries the host's own seeded catalog (`catalog.*`
    // ids, `template-definitions.ts`). Read those ids from the catalog
    // itself rather than listing them here, so a new template needs no edit
    // — but keep the set exact. The route layer SKIPS a template whose
    // definition fails to summarize (`listWorkflowTemplateSummaries`) and
    // only logs it, so asserting on the plugin partition alone would let the
    // whole catalog vanish from the gallery without failing a test.
    const ids = body.templates.map((t) => t.id).sort();
    const expected = [...builtinWorkflowTemplates.map((t) => t.id), "gmail-sweep", "notes-echo"];
    expect(ids).toEqual(expected.sort());

    const sweep = body.templates.find((t) => t.id === "gmail-sweep");
    expect(sweep?.requires).toEqual([{ service: "gmail", connected: false }]);
    expect(sweep?.schedule).toEqual({ cron: "0 12 * * 1-5", timezone: "UTC" });
    expect(sweep?.steps).toEqual(["Read the labels"]);

    const echo = body.templates.find((t) => t.id === "notes-echo");
    expect(echo?.schedule).toBeNull();
    expect(echo?.inputs).toEqual([{ name: "noteId", type: "string", label: "Note id", required: false }]);
  });

  it("reports a service as connected once the caller connects it", async () => {
    const a = await boot();
    await a.providers.engineCredentials.save({ type: "user", id: "local-user" }, "gmail", {
      type: "oauth2",
      accessToken: "token",
    });
    const body = (await (await fetch(`${a.baseUrl}/api/templates`)).json()) as ListWorkflowTemplatesResponse;
    expect(body.templates.find((t) => t.id === "gmail-sweep")?.requires).toEqual([
      { service: "gmail", connected: true },
    ]);
  });
});

describe("POST /api/templates/:id/install", () => {
  it("installs from an empty body and the workflow shows up in the list", async () => {
    const a = await boot();
    const res = await install(a.baseUrl, "notes-echo");
    expect(res.status).toBe(201);
    const body = (await res.json()) as InstallWorkflowTemplateResponse;
    expect(body.workflowName).toBe("Notes echo");
    expect(body.scheduleId).toBeUndefined();

    const list = (await (await fetch(`${a.baseUrl}/api/workflows`)).json()) as ListWorkflowsResponse;
    expect(list.workflows.map((w) => w.id)).toEqual([body.workflowId]);
  });

  it("arms the schedule the template declares", async () => {
    const a = await boot();
    await a.providers.engineCredentials.save({ type: "user", id: "local-user" }, "gmail", {
      type: "oauth2",
      accessToken: "token",
    });
    const res = await install(a.baseUrl, "gmail-sweep");
    expect(res.status).toBe(201);
    const body = (await res.json()) as InstallWorkflowTemplateResponse;
    expect(body.scheduleId).toBeDefined();

    const schedules = await a.providers.db.select().from(workflowSchedules);
    expect(schedules).toHaveLength(1);
    expect(schedules[0]!.workflowId).toBe(body.workflowId);
    expect(schedules[0]!.name).toContain(body.workflowId.slice(-6));
  });

  it("refuses a template whose service is not connected, and names the fix", async () => {
    const a = await boot();
    const res = await install(a.baseUrl, "gmail-sweep");
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("Connect gmail in Integrations, then install this template.");
    expect(await a.providers.db.select().from(workflowDefinitions)).toHaveLength(0);
  });

  it("404s an unknown template id", async () => {
    const a = await boot();
    const res = await install(a.baseUrl, "no-such-template");
    expect(res.status).toBe(404);
  });

  it("404s a team the caller does not belong to", async () => {
    const a = await boot();
    await a.providers.db.insert(teams).values({ id: "t-1", orgId: "local-org", name: "Platform", createdAt: Date.now() });
    await a.providers.db.insert(teamMembers).values({ teamId: "t-1", userId: "someone-else", role: "member" });

    const res = await install(a.baseUrl, "notes-echo", { teamId: "t-1" });
    expect(res.status).toBe(404);
    expect(await a.providers.db.select().from(workflowDefinitions)).toHaveLength(0);
  });

  it("installs into a team the caller belongs to", async () => {
    const a = await boot();
    await a.providers.db.insert(teams).values({ id: "t-2", orgId: "local-org", name: "Platform", createdAt: Date.now() });
    await a.providers.db.insert(teamMembers).values({ teamId: "t-2", userId: "local-user", role: "member" });

    const res = await install(a.baseUrl, "notes-echo", { teamId: "t-2" });
    expect(res.status).toBe(201);
    const rows = await a.providers.db.select().from(workflowDefinitions);
    expect(rows[0]!.ownerType).toBe("team");
    expect(rows[0]!.ownerId).toBe("t-2");
  });

  it("rejects a malformed body", async () => {
    const a = await boot();
    const res = await install(a.baseUrl, "notes-echo", "{not json");
    expect(res.status).toBe(400);
    expect((await res.json()) as { error: string }).toEqual({ error: "invalid JSON body" });
  });

  it("rejects a body that is not an object, and inputs that are not an object", async () => {
    const a = await boot();
    const notAnObject = await install(a.baseUrl, "notes-echo", '"hello"');
    expect(notAnObject.status).toBe(400);

    const badInputs = await install(a.baseUrl, "notes-echo", '{"inputs":"hello"}');
    expect(badInputs.status).toBe(400);
    expect(((await badInputs.json()) as { error: string }).error).toContain("inputs must be a JSON object");
    expect(await a.providers.db.select().from(workflowDefinitions)).toHaveLength(0);
  });

  it("400s an input of the wrong type, with the field named", async () => {
    const a = await boot();
    const res = await install(a.baseUrl, "notes-echo", { inputs: { noteId: 7 } });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string; errors: string[] };
    expect(body.errors.join(" ")).toContain("noteId");
  });
});

describe("a service that is not available yet", () => {
  it("hides the templates that need it, and keeps the rest", async () => {
    const a = await boot();
    const res = await fetch(`${a.baseUrl}/api/templates`);
    const body = (await res.json()) as ListWorkflowTemplatesResponse;
    const ids = body.templates.map((t) => t.id);

    // Nothing on offer may require a service a person cannot connect.
    for (const t of body.templates) {
      expect(t.requires.map((r) => r.service)).not.toContain("slack");
    }
    // And the gallery is not empty as a result — the fixture plugins remain.
    expect(ids).toContain("notes-echo");
  });
});
