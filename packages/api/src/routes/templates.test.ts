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
import { eq, sql } from "drizzle-orm";
import type { ActionPlugin, PluginAction, ValetPlugin, WorkflowTemplate } from "@valet/engine";
import { bootTestApi, type TestApi } from "../integration/_setup.js";
import { builtinWorkflowTemplates } from "../workflows/template-definitions.js";
import { actionPolicies, teamMembers, teams, workflowAccountGrants, workflowActionGrants, workflowDefinitions, workflowSchedules } from "../schema/index.js";
import { createTeam, addMember } from "../services/teams.js";
import { shareCredential } from "../services/credential-shares.js";
import { installWorkflowTemplate } from "../workflows/templates.js";
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

function action(
  id: string,
  parameters: PluginAction["parameters"] = Type.Object({}),
): PluginAction {
  return {
    id,
    name: id,
    description: id,
    riskLevel: "low",
    parameters,
    execute: () => Promise.resolve({ success: true, data: {} }),
  };
}

const gmailActions: ActionPlugin = { service: "gmail", actions: [action("gmail.list_labels")] };
/** The read action declares the params its fixture template sends — the
 * save-time params lint checks tool params against this schema. */
const notesActions: ActionPlugin = {
  service: "notes",
  actions: [action("notes.read", Type.Object({ id: Type.String() }))],
};

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

/**
 * `?teamId=` asks the question the team install answers. Without it the
 * gallery judged the caller while the install judged the team, so a team
 * that held Gmail still got a card with Install disabled and no way to
 * change the answer.
 */
describe("GET /api/templates?teamId=", () => {
  async function seedTeam(a: TestApi, teamId: string, userId: string): Promise<void> {
    await a.providers.db.insert(teams).values({ id: teamId, orgId: "local-org", name: teamId, createdAt: Date.now() });
    await a.providers.db.insert(teamMembers).values({ teamId, userId, role: "member" });
  }

  it("reports a service the team holds as connected, though the caller has not connected it", async () => {
    const a = await boot();
    await seedTeam(a, "t-list", "local-user");
    await a.providers.engineCredentials.save({ type: "team", id: "t-list" }, "gmail", {
      type: "oauth2",
      accessToken: "team-token",
    });

    const res = await fetch(`${a.baseUrl}/api/templates?teamId=t-list`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as ListWorkflowTemplatesResponse;
    expect(body.templates.find((t) => t.id === "gmail-sweep")?.requires).toEqual([
      { service: "gmail", connected: true },
    ]);
  });

  it("reports a service only the caller holds as not connected for the team", async () => {
    const a = await boot();
    await seedTeam(a, "t-list-2", "local-user");
    await a.providers.engineCredentials.save({ type: "user", id: "local-user" }, "gmail", {
      type: "oauth2",
      accessToken: "token",
    });

    const body = (await (
      await fetch(`${a.baseUrl}/api/templates?teamId=t-list-2`)
    ).json()) as ListWorkflowTemplatesResponse;
    expect(body.templates.find((t) => t.id === "gmail-sweep")?.requires).toEqual([
      { service: "gmail", connected: false },
    ]);
  });

  it("404s a team the caller does not belong to, whatever that team has connected", async () => {
    const a = await boot();
    await seedTeam(a, "t-theirs", "someone-else");
    await a.providers.engineCredentials.save({ type: "team", id: "t-theirs" }, "gmail", {
      type: "oauth2",
      accessToken: "team-token",
    });

    const res = await fetch(`${a.baseUrl}/api/templates?teamId=t-theirs`);
    expect(res.status).toBe(404);
    expect(((await res.json()) as { error: string }).error).toContain("Choose a team you belong to");
  });

  it("treats an empty teamId as no team, not as an unknown one", async () => {
    const a = await boot();
    const res = await fetch(`${a.baseUrl}/api/templates?teamId=`);
    expect(res.status).toBe(200);
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


describe("template install authorization", () => {
  const consentDefinition = definition([
    { id: "start", type: "trigger" },
    { id: "send", type: "tool", service: "install-fixture", action: "send", params: {} },
    { id: "stop", type: "stop" },
  ], [{ from: "start", to: "send" }, { from: "send", to: "stop" }]);
  const consentTemplate: WorkflowTemplate = {
    id: "install-consent", name: "Install consent", description: "Sends a fixture message.",
    category: "Tests", apps: ["install-fixture"], steps: ["Send"], definition: consentDefinition,
  };
  const consentPlugin: ValetPlugin = {
    name: "install-fixture", version: "1", credentials: [{ type: "api_key", service: "install-fixture", configKeys: [] }],
    actions: [{ service: "install-fixture", actions: [{ ...action("install-fixture.send"), riskLevel: "high" }] }],
    templates: [consentTemplate, { ...consentTemplate, id: "install-consent-scheduled", schedule: { name: "Consent schedule", cron: "0 12 * * *", timezone: "UTC", description: "Every day" } }],
  };

  async function bootConsent() {
    api = await bootTestApi({ plugins: [consentPlugin] });
    await api.providers.engineCredentials.save({ type: "user", id: "local-user" }, "install-fixture", { type: "api_key", apiKey: "fixture" });
    return api;
  }

  async function installedWorkflowId(response: Response): Promise<string> {
    expect(response.status, await response.clone().text()).toBe(201);
    const body: unknown = await response.json();
    if (!body || typeof body !== "object" || !("workflowId" in body) || typeof body.workflowId !== "string") throw new Error("Missing installed workflow ID.");
    return body.workflowId;
  }

  it("authorizes declared high-risk tool actions during a human HTTP install", async () => {
    const a = await bootConsent();
    const id = await installedWorkflowId(await install(a.baseUrl, "install-consent"));
    expect(await a.providers.db.select().from(workflowActionGrants)).toMatchObject([
      { workflowId: id, actionId: "install-fixture.send", grantedBy: "local-user", ownerType: "user", ownerId: "local-user" },
    ]);
  });

  it("authorizes a team admin's actions and own shared account before enabling the installed schedule", async () => {
    const a = await bootConsent();
    const db = a.providers.db;
    const team = await createTeam(db, { orgId: "local-org", name: "Install team", creatorUserId: "local-user" });
    await addMember(db, { teamId: team.id, userId: "test-member", role: "member" });
    await a.providers.engineCredentials.save({ type: "user", id: "test-member" }, "install-fixture", { type: "api_key", apiKey: "other-fixture" });
    for (const userId of ["local-user", "test-member"]) await shareCredential(db, { teamId: team.id, userId, service: "install-fixture", createdAt: 1 });
    await db.execute(sql`CREATE FUNCTION require_installed_template_consent() RETURNS trigger AS $$
      BEGIN
        IF NEW.enabled AND (NOT EXISTS (SELECT 1 FROM workflow_action_grants WHERE workflow_id = NEW.workflow_id)
          OR NOT EXISTS (SELECT 1 FROM workflow_account_grants WHERE workflow_id = NEW.workflow_id AND member_id = 'local-user')) THEN
          RAISE EXCEPTION 'Template consent must precede the enabled schedule';
        END IF;
        RETURN NEW;
      END;
      $$ LANGUAGE plpgsql`);
    await db.execute(sql`CREATE TRIGGER require_installed_template_consent BEFORE INSERT ON workflow_schedules
      FOR EACH ROW EXECUTE FUNCTION require_installed_template_consent()`);
    const id = await installedWorkflowId(await install(a.baseUrl, "install-consent-scheduled", { teamId: team.id }));
    expect(await db.select().from(workflowActionGrants)).toMatchObject([{ workflowId: id, ownerType: "team", ownerId: team.id, actionId: "install-fixture.send" }]);
    expect(await db.select().from(workflowAccountGrants)).toMatchObject([{ workflowId: id, memberId: "local-user", service: "install-fixture" }]);
    expect(await db.select().from(workflowAccountGrants)).toHaveLength(1);
    expect(await db.select().from(workflowSchedules).where(eq(workflowSchedules.workflowId, id))).toMatchObject([{ enabled: true }]);
  });

  it.each([false, true])("does not auto-authorize a service or agent install (agent=%s)", async agentEditor => {
    const a = await bootConsent();
    const p = a.providers;
    const result = await installWorkflowTemplate({ db: p.db, plugins: p.plugins, actionPluginByService: p.actionPluginByService, credentials: p.engineCredentials },
      { userId: "local-user", orgId: "local-org", principal: { type: "user", id: "local-user" }, humanAccountConsent: agentEditor, agentEditor }, "install-consent");
    expect(result.ok).toBe(true);
    expect(await p.db.select().from(workflowActionGrants)).toHaveLength(0);
    expect(await p.db.select().from(workflowAccountGrants)).toHaveLength(0);
  });

  it("preserves an organization's approval policy after a human install", async () => {
    const a = await bootConsent();
    await a.providers.db.insert(actionPolicies).values({ id: "install-org-gate", orgId: "local-org", principalType: "org", principalId: "local-org",
      actionId: "install-fixture.send", mode: "require_approval", paramMatchers: [], appliesIn: "workflow", origin: "settings", createdAt: 1, updatedAt: 1 });
    const id = await installedWorkflowId(await install(a.baseUrl, "install-consent"));
    expect(await a.providers.db.select().from(workflowActionGrants)).toHaveLength(0);
    const preview = await fetch(`${a.baseUrl}/api/workflows/${id}/permissions`);
    expect(preview.status).toBe(200);
    expect(await preview.json()).toMatchObject({ nodes: [expect.objectContaining({ nodeId: "send", mode: "require_approval", provenance: "org_policy" })] });
  });
});
