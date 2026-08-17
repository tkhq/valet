/**
 * Workflow template aggregation and install.
 *
 * The install path is the reason this file exists. It writes three rows —
 * a definition, its version-1 snapshot, and a cron schedule — and a
 * half-written install is worse than a failed one: a schedule armed
 * against a workflow that does not exist fires forever and fails forever.
 * `install writes nothing when a later write fails` forces exactly that
 * failure with a database constraint and asserts the first two rows are
 * gone too.
 */
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { Type } from "typebox";
import { and, eq } from "drizzle-orm";
import type {
  ActionPlugin,
  CredentialStore,
  PluginAction,
  StoredCredential,
  ValetPlugin,
  WorkflowTemplate,
} from "@valet/engine";
import { InMemoryCredentialStore } from "@valet/engine";
import type { WorkflowDefinition } from "@valet/workflow";
import { freshTestPgDb } from "../test-helpers/pg-test-db.js";
import type { AppDb } from "../lib/drizzle.js";
import type { PgDb } from "@valet/store-postgres";
import { teamMembers, teams, workflowDefinitions, workflowSchedules, workflowVersions } from "../schema/index.js";
import { assemblePlugins } from "../plugins/assemble.js";
import {
  bakeInputs,
  installWorkflowTemplate,
  listPluginTemplates,
  listWorkflowTemplateSummaries,
  templateInputs,
  type TemplateServiceDeps,
} from "./templates.js";

const OWNER = { userId: "u-1", orgId: "org-1" };

// ─── Fixture plugins ─────────────────────────────────────────────────────

function action(id: string, riskLevel: PluginAction["riskLevel"]): PluginAction {
  return {
    id,
    name: id,
    description: id,
    riskLevel,
    parameters: Type.Object({}),
    execute: () => Promise.resolve({ success: true, data: {} }),
  };
}

const gmailActions: ActionPlugin = {
  service: "gmail",
  actions: [action("gmail.list_labels", "low"), action("gmail.send_email", "high")],
};

const linearActions: ActionPlugin = {
  service: "linear",
  // A dynamic resolver is what makes an MCP-backed service's action NAMES
  // unverifiable at save time — the caveat the summary must carry.
  actions: [],
  resolveActions: () => Promise.resolve([action("linear.list_issues", "medium")]),
};

/** No credential declaration anywhere, so nothing needs connecting. */
const localActions: ActionPlugin = { service: "notes", actions: [action("notes.read", "low")] };

function definition(nodes: unknown[], edges: unknown[]): unknown {
  return { version: "dag/v1", nodes, edges };
}

const sweepDefinition = definition(
  [
    { id: "start", type: "trigger" },
    { id: "labels", type: "tool", service: "gmail", action: "list_labels", params: {} },
    {
      id: "batch",
      type: "foreach",
      items: "{{ nodes.labels.result.labels }}",
      maxItems: 25,
      body: { id: "one", type: "llm", model: "claude-haiku-4-5", prompt: "{{ item }}" },
    },
  ],
  [
    { from: "start", to: "labels" },
    { from: "labels", to: "batch" },
  ],
);

const gmailSweep: WorkflowTemplate = {
  id: "gmail-sweep",
  name: "Inbox sweeper",
  description: "Moves low-priority mail onto one label.",
  category: "Inbox",
  apps: ["gmail"],
  steps: ["Read the labels", "Sort the mail"],
  definition: sweepDefinition,
  schedule: { name: "Inbox sweeper", cron: "0 12 * * 1-5", timezone: "UTC", description: "Weekdays at 12:00" },
};

const gmailBlast: WorkflowTemplate = {
  id: "gmail-blast",
  name: "Mail blast",
  description: "Sends a message.",
  category: "Inbox",
  apps: ["gmail"],
  steps: ["Send"],
  caveats: ["Written by the template author."],
  definition: definition(
    [
      { id: "start", type: "trigger" },
      { id: "send", type: "tool", service: "gmail", action: "send_email", params: {} },
    ],
    [{ from: "start", to: "send" }],
  ),
};

const linearDigest: WorkflowTemplate = {
  id: "linear-digest",
  name: "Linear digest",
  description: "Summarizes open issues.",
  category: "Daily digest",
  apps: ["linear"],
  steps: ["Read the issues"],
  definition: definition(
    [
      { id: "start", type: "trigger" },
      { id: "issues", type: "tool", service: "linear", action: "list_issues", params: {} },
    ],
    [{ from: "start", to: "issues" }],
  ),
};

/** Needs no credential, and reads one baked-in parameter. */
const notesTemplate: WorkflowTemplate = {
  id: "notes-echo",
  name: "Notes echo",
  description: "Reads one note.",
  category: "Batch work",
  apps: ["notes"],
  steps: ["Read"],
  definition: definition(
    [
      {
        id: "start",
        type: "trigger",
        dataSchema: {
          noteId: { type: "string", required: true, label: "Note id", placeholder: "n_123" },
          secret: { type: "string", hidden: true },
          rows: { type: "array" },
        },
      },
      { id: "read", type: "tool", service: "notes", action: "read", params: { id: "{{ trigger.data.noteId }}" } },
    ],
    [{ from: "start", to: "read" }],
  ),
};

/**
 * Scheduled AND parameterised — the combination the baking rule exists for.
 * A scheduled run applies no `dataSchema` defaults, so install has to
 * resolve every field before it writes: the declared default for one, and a
 * refusal for the required field nobody supplied.
 */
const notesNightly: WorkflowTemplate = {
  id: "notes-nightly",
  name: "Notes nightly",
  description: "Reads one note every night.",
  category: "Batch work",
  apps: ["notes"],
  steps: ["Read"],
  definition: definition(
    [
      {
        id: "start",
        type: "trigger",
        dataSchema: {
          noteId: { type: "string", required: true, label: "Note id", placeholder: "n_123" },
          depth: { type: "number", required: true, default: 3, label: "Depth" },
        },
      },
      {
        id: "read",
        type: "tool",
        service: "notes",
        action: "read",
        params: { id: "{{ trigger.data.noteId }}", depth: "{{ trigger.data.depth }}" },
      },
    ],
    [{ from: "start", to: "read" }],
  ),
  schedule: { name: "Notes nightly", cron: "0 3 * * *", timezone: "UTC", description: "Every day at 03:00" },
};

const brokenTemplate: WorkflowTemplate = {
  id: "broken",
  name: "Broken",
  description: "References a node that does not exist.",
  category: "Batch work",
  apps: [],
  steps: [],
  definition: definition(
    [
      { id: "start", type: "trigger" },
      { id: "read", type: "tool", service: "notes", action: "read", params: { id: "{{ nodes.ghost.result.id }}" } },
    ],
    [{ from: "start", to: "read" }],
  ),
};

const gmailPlugin: ValetPlugin = {
  name: "gmail",
  version: "0.0.1",
  actions: [gmailActions],
  credentials: [{ type: "oauth2", service: "gmail", configKeys: [] }],
  templates: [gmailSweep, gmailBlast],
};

const linearPlugin: ValetPlugin = {
  name: "linear",
  version: "0.0.1",
  actions: [linearActions],
  credentials: [{ type: "oauth2", service: "linear", configKeys: [] }],
  templates: [linearDigest],
};

const notesPlugin: ValetPlugin = {
  name: "notes",
  version: "0.0.1",
  actions: [localActions],
  templates: [notesTemplate, notesNightly, brokenTemplate],
};

// ─── Harness ─────────────────────────────────────────────────────────────

let db: AppDb;
let pgdb: PgDb;
let credentials: CredentialStore;

async function boot(): Promise<void> {
  const fresh = await freshTestPgDb();
  db = fresh.appDb;
  pgdb = fresh.pgdb;
}

function deps(plugins: ValetPlugin[] = [gmailPlugin, linearPlugin, notesPlugin]): TemplateServiceDeps {
  const assembled = assemblePlugins([plugins]);
  return {
    db,
    plugins: assembled.plugins,
    actionPluginByService: assembled.actionPluginByService,
    credentials,
  };
}

async function connect(service: string, userId = OWNER.userId): Promise<void> {
  const cred: StoredCredential = { type: "oauth2", accessToken: `token-${service}` };
  await credentials.save({ type: "user", id: userId }, service, cred);
}

async function seedTeam(teamId: string, memberIds: string[]): Promise<void> {
  await db.insert(teams).values({ id: teamId, orgId: OWNER.orgId, name: teamId, createdAt: Date.now() });
  for (const userId of memberIds) {
    await db.insert(teamMembers).values({ teamId, userId, role: "member" });
  }
}

beforeEach(async () => {
  await boot();
  credentials = new InMemoryCredentialStore();
});

afterAll(async () => {
  // `freshTestPgDb` shares one PGlite instance per process; nothing to close.
});

// ─── Aggregation ─────────────────────────────────────────────────────────

describe("listPluginTemplates", () => {
  it("flattens every loaded plugin's templates in plugin order", () => {
    const owned = listPluginTemplates([gmailPlugin, linearPlugin]);
    expect(owned.map((o) => o.template.id)).toEqual(["gmail-sweep", "gmail-blast", "linear-digest"]);
    expect(owned[0]!.pluginName).toBe("gmail");
  });

  it("returns nothing for a plugin set that contributes no template", () => {
    expect(listPluginTemplates([{ name: "bare", version: "0.0.1" }])).toEqual([]);
  });

  it("throws on a repeated id, naming both plugins", () => {
    const twin: ValetPlugin = { name: "twin", version: "0.0.1", templates: [gmailSweep] };
    expect(() => listPluginTemplates([gmailPlugin, twin])).toThrow(/"gmail-sweep".*"gmail".*"twin"/s);
  });
});

// ─── Listing ─────────────────────────────────────────────────────────────

describe("listWorkflowTemplateSummaries", () => {
  it("reports an unconnected service, and flips it once connected", async () => {
    const before = await listWorkflowTemplateSummaries(deps(), OWNER.userId);
    const sweepBefore = before.find((t) => t.id === "gmail-sweep");
    expect(sweepBefore?.requires).toEqual([{ service: "gmail", connected: false }]);

    await connect("gmail");
    const after = await listWorkflowTemplateSummaries(deps(), OWNER.userId);
    expect(after.find((t) => t.id === "gmail-sweep")?.requires).toEqual([{ service: "gmail", connected: true }]);
  });

  it("treats a service that declares no credential as needing nothing", async () => {
    const list = await listWorkflowTemplateSummaries(deps(), OWNER.userId);
    expect(list.find((t) => t.id === "notes-echo")?.requires).toEqual([{ service: "notes", connected: true }]);
  });

  it("marks a service that resolves its actions at run time", async () => {
    const list = await listWorkflowTemplateSummaries(deps(), OWNER.userId);
    expect(list.find((t) => t.id === "linear-digest")?.requires).toEqual([
      { service: "linear", connected: false, dynamic: true },
    ]);
  });

  it("hides a template whose definition does not validate", async () => {
    const list = await listWorkflowTemplateSummaries(deps(), OWNER.userId);
    expect(list.map((t) => t.id)).not.toContain("broken");
    expect(list.map((t) => t.id)).toContain("notes-echo");
  });

  it("derives the caveats the definition can prove, after the author's own", async () => {
    const list = await listWorkflowTemplateSummaries(deps(), OWNER.userId);

    expect(list.find((t) => t.id === "gmail-sweep")?.caveats).toEqual([
      "Each run processes at most 25 items. The workflow reports the count it did not process.",
    ]);

    const blast = list.find((t) => t.id === "gmail-blast");
    expect(blast?.caveats[0]).toBe("Written by the template author.");
    expect(blast?.caveats[1]).toContain("gmail.send_email");
    expect(blast?.caveats[1]).toContain("high risk");

    expect(list.find((t) => t.id === "linear-digest")?.caveats[0]).toContain("finds its action when the workflow runs");
  });

  it("does not repeat a limit the author already wrote about", async () => {
    const spelledOut: WorkflowTemplate = {
      ...gmailSweep,
      id: "gmail-sweep-documented",
      caveats: ["It sorts at most 25 messages per run.", "It reads linear only to name the issue."],
    };
    const plugin: ValetPlugin = { ...gmailPlugin, templates: [spelledOut] };
    const list = await listWorkflowTemplateSummaries(deps([plugin, linearPlugin, notesPlugin]), OWNER.userId);
    // "25" appears in the author's line, so the derived foreach line is
    // dropped rather than said twice.
    expect(list.find((t) => t.id === "gmail-sweep-documented")?.caveats).toEqual(spelledOut.caveats);
  });

  it("still names a high-risk step even when the author wrote about it", async () => {
    const documented: WorkflowTemplate = {
      ...gmailBlast,
      id: "gmail-blast-documented",
      caveats: ["This sends mail through gmail.send_email."],
    };
    const plugin: ValetPlugin = { ...gmailPlugin, templates: [documented] };
    const list = await listWorkflowTemplateSummaries(deps([plugin]), OWNER.userId);
    // An approval gate on an unattended run is the one thing card copy
    // must never be able to hide, so this line is never suppressed.
    expect(list[0]?.caveats).toHaveLength(2);
    expect(list[0]?.caveats[1]).toContain("high risk");
  });

  it("says a scheduled high-risk step makes the run wait, not fail", async () => {
    const scheduledBlast: WorkflowTemplate = {
      ...gmailBlast,
      id: "gmail-blast-daily",
      caveats: undefined,
      schedule: { name: "Blast", cron: "0 9 * * *", timezone: "UTC", description: "Daily at 09:00" },
    };
    const plugin: ValetPlugin = { ...gmailPlugin, templates: [scheduledBlast] };
    const list = await listWorkflowTemplateSummaries(deps([plugin]), OWNER.userId);
    expect(list[0]?.caveats[0]).toContain("a scheduled run then waits until a person answers");
  });

  it("carries the schedule the gallery shows, and null when there is none", async () => {
    const list = await listWorkflowTemplateSummaries(deps(), OWNER.userId);
    expect(list.find((t) => t.id === "gmail-sweep")?.schedule).toEqual({ cron: "0 12 * * 1-5", timezone: "UTC" });
    expect(list.find((t) => t.id === "linear-digest")?.schedule).toBeNull();
  });
});

describe("templateInputs", () => {
  it("labels each field, drops hidden fields, and drops non-primitives", () => {
    expect(
      templateInputs({
        noteId: { type: "string", required: true, label: "Note id", placeholder: "n_123" },
        secret: { type: "string", hidden: true },
        rows: { type: "array" },
        count: { type: "number", default: 5 },
      }),
    ).toEqual([
      { name: "noteId", type: "string", label: "Note id", placeholder: "n_123", required: true },
      { name: "count", type: "number", label: "count", required: false, default: 5 },
    ]);
  });

  it("is empty for a trigger that declares no schema", () => {
    expect(templateInputs(undefined)).toEqual([]);
  });
});

// ─── Baking ──────────────────────────────────────────────────────────────

describe("bakeInputs", () => {
  const base: WorkflowDefinition = {
    version: "dag/v1",
    nodes: [
      { id: "start", type: "trigger", dataSchema: { channel: { type: "string" }, note: { type: "string" } } },
      {
        id: "read",
        type: "tool",
        service: "notes",
        action: "read",
        params: { id: "{{ trigger.data.channel }}", label: "for {{ trigger.data.channel }} today" },
      },
    ],
    edges: [{ from: "start", to: "read" }],
  };

  it("keeps the value's type in a single-expression field and stringifies in mixed text", () => {
    const baked = bakeInputs(base, { channel: "C123" });
    const node = baked.nodes[1];
    expect(node?.type).toBe("tool");
    if (node?.type !== "tool") throw new Error("expected a tool node");
    expect(node.params.id).toBe("C123");
    expect(node.params.label).toBe("for C123 today");
  });

  it("drops a baked field from the trigger schema and keeps the others", () => {
    const baked = bakeInputs(base, { channel: "C123" });
    const trigger = baked.nodes[0];
    if (trigger?.type !== "trigger") throw new Error("expected a trigger node");
    expect(Object.keys(trigger.dataSchema ?? {})).toEqual(["note"]);
  });

  it("leaves the definition alone when there is nothing to bake", () => {
    expect(bakeInputs(base, {})).toBe(base);
  });

  it("keeps a field whose remaining reference it cannot rewrite", () => {
    const nested: WorkflowDefinition = {
      version: "dag/v1",
      nodes: [
        { id: "start", type: "trigger", dataSchema: { rows: { type: "object" } } },
        { id: "set", type: "set", values: { first: "{{ trigger.data.rows.first }}" } },
      ],
      edges: [{ from: "start", to: "set" }],
    };
    const baked = bakeInputs(nested, { rows: "x" });
    const trigger = baked.nodes[0];
    if (trigger?.type !== "trigger") throw new Error("expected a trigger node");
    // `trigger.data.rows.first` is a longer path, so the literal cannot be
    // written in — the field must stay declared.
    expect(Object.keys(trigger.dataSchema ?? {})).toEqual(["rows"]);
  });

  it("does not mutate the template the plugin ships", () => {
    const snapshot = JSON.stringify(base);
    bakeInputs(base, { channel: "C123" });
    expect(JSON.stringify(base)).toBe(snapshot);
  });
});

// ─── Install ─────────────────────────────────────────────────────────────

describe("installWorkflowTemplate", () => {
  it("writes the definition, its first version, and the schedule", async () => {
    await connect("gmail");
    const result = await installWorkflowTemplate(deps(), OWNER, "gmail-sweep");
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.error);

    const defs = await db.select().from(workflowDefinitions);
    expect(defs).toHaveLength(1);
    expect(defs[0]!.name).toBe("Inbox sweeper");
    expect(defs[0]!.ownerType).toBe("user");
    expect(defs[0]!.ownerId).toBe(OWNER.userId);

    const versions = await db.select().from(workflowVersions);
    expect(versions).toHaveLength(1);
    expect(versions[0]!.version).toBe(1);
    expect(versions[0]!.workflowId).toBe(result.workflowId);

    const schedules = await db.select().from(workflowSchedules);
    expect(schedules).toHaveLength(1);
    expect(schedules[0]!.workflowId).toBe(result.workflowId);
    expect(schedules[0]!.enabled).toBe(true);
    expect(schedules[0]!.nextFireAt).toBeGreaterThan(Date.now());
    // The suffix comes from the workflow id minted in the same transaction.
    expect(schedules[0]!.name).toBe(`Inbox sweeper (${result.workflowId.slice(-6)})`);
    expect(result.scheduleId).toBe(schedules[0]!.id);
  });

  it("arms no schedule for a template that declares none", async () => {
    const result = await installWorkflowTemplate(deps(), OWNER, "notes-echo");
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.error);
    expect(result.scheduleId).toBeUndefined();
    expect(await db.select().from(workflowSchedules)).toHaveLength(0);
  });

  it("refuses a template whose service the caller has not connected", async () => {
    const result = await installWorkflowTemplate(deps(), OWNER, "gmail-sweep");
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected a refusal");
    expect(result.code).toBe("not_connected");
    expect(result.error).toBe("Connect gmail in Integrations, then install this template.");
    // Nothing was written, so the gallery can offer the card again after
    // the person connects.
    expect(await db.select().from(workflowDefinitions)).toHaveLength(0);
    expect(await db.select().from(workflowSchedules)).toHaveLength(0);
  });

  it("reports an unknown template id", async () => {
    const result = await installWorkflowTemplate(deps(), OWNER, "no-such-template");
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected a refusal");
    expect(result.code).toBe("not_found");
  });

  it("refuses a template whose definition does not validate", async () => {
    const result = await installWorkflowTemplate(deps(), OWNER, "broken");
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected a refusal");
    if (result.code !== "broken_template") throw new Error(`expected broken_template, got ${result.code}`);
    expect(result.errors.join(" ")).toContain("ghost");
    expect(await db.select().from(workflowDefinitions)).toHaveLength(0);
  });

  it("writes nothing when a later write in the transaction fails", async () => {
    await connect("gmail");
    // Force the LAST of the three writes to fail. Without one transaction
    // the definition and its version would survive, and the gallery would
    // show an installed workflow that never runs.
    await pgdb.query("ALTER TABLE workflow_schedules ADD CONSTRAINT no_writes CHECK (false) NOT VALID");

    try {
      await expect(installWorkflowTemplate(deps(), OWNER, "gmail-sweep")).rejects.toThrow();

      expect(await db.select().from(workflowDefinitions)).toHaveLength(0);
      expect(await db.select().from(workflowVersions)).toHaveLength(0);
      expect(await db.select().from(workflowSchedules)).toHaveLength(0);
    } finally {
      // Drop the constraint also when an assertion above fails. The tests in
      // this package share one database, so a constraint that stays makes
      // every later write to this table fail.
      await pgdb.query("ALTER TABLE workflow_schedules DROP CONSTRAINT no_writes");
    }
  });

  it("installs the same template twice as two independent workflows", async () => {
    await connect("gmail");
    const first = await installWorkflowTemplate(deps(), OWNER, "gmail-sweep");
    const second = await installWorkflowTemplate(deps(), OWNER, "gmail-sweep");
    expect(first.ok && second.ok).toBe(true);
    if (!first.ok || !second.ok) throw new Error("expected both installs to succeed");

    expect(second.workflowId).not.toBe(first.workflowId);
    expect(first.workflowName).toBe("Inbox sweeper");
    expect(second.workflowName).toBe("Inbox sweeper (2)");

    const defs = await db.select().from(workflowDefinitions);
    expect(defs).toHaveLength(2);
    // The first install is untouched: same id, same name, same definition.
    const firstRow = defs.find((d) => d.id === first.workflowId);
    expect(firstRow?.name).toBe("Inbox sweeper");
    expect(firstRow?.definition).toEqual(sweepDefinition);

    const schedules = await db.select().from(workflowSchedules);
    expect(schedules).toHaveLength(2);
    expect(new Set(schedules.map((s) => s.id)).size).toBe(2);
    // Distinct names are the whole point of the suffix: two rows called
    // "Inbox sweeper" cannot be told apart in the schedules list.
    expect(new Set(schedules.map((s) => s.name)).size).toBe(2);
    expect(new Set(schedules.map((s) => s.workflowId))).toEqual(new Set([first.workflowId, second.workflowId]));
  });

  it("bakes a supplied input into the installed definition", async () => {
    const result = await installWorkflowTemplate(deps(), OWNER, "notes-echo", { inputs: { noteId: "n_42" } });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.error);

    const row = (await db.select().from(workflowDefinitions))[0]!;
    const stored: unknown = row.definition;
    expect(JSON.stringify(stored)).toContain('"id":"n_42"');
    expect(JSON.stringify(stored)).not.toContain("trigger.data.noteId");
  });

  it("rejects an input of the wrong type before it writes anything", async () => {
    const result = await installWorkflowTemplate(deps(), OWNER, "notes-echo", { inputs: { noteId: 7 } });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected a refusal");
    if (result.code !== "invalid_input") throw new Error(`expected invalid_input, got ${result.code}`);
    expect(result.errors.join(" ")).toContain("must be a string");
    expect(await db.select().from(workflowDefinitions)).toHaveLength(0);
  });

  it("rejects an input the template does not take, and names the ones it does", async () => {
    const result = await installWorkflowTemplate(deps(), OWNER, "notes-echo", { inputs: { noteid: "n_42" } });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected a refusal");
    if (result.code !== "invalid_input") throw new Error(`expected invalid_input, got ${result.code}`);
    expect(result.errors[0]).toContain('"noteid" is not an input of this template');
    expect(result.errors[0]).toContain("noteId");
    expect(await db.select().from(workflowDefinitions)).toHaveLength(0);
  });

  it("keeps an unsupplied input as a run-time field", async () => {
    const result = await installWorkflowTemplate(deps(), OWNER, "notes-echo");
    expect(result.ok).toBe(true);
    const row = (await db.select().from(workflowDefinitions))[0]!;
    expect(JSON.stringify(row.definition)).toContain("trigger.data.noteId");
  });

  it("refuses a scheduled install with no value for a required input, and names the field", async () => {
    // The same omission on a manual template is harmless — its run form
    // collects the value later. On a schedule there is no later: the cron
    // run gets no defaults and no form, so the reference would read null
    // every night with nothing to report it.
    const result = await installWorkflowTemplate(deps(), OWNER, "notes-nightly");
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected a refusal");
    if (result.code !== "invalid_input") throw new Error(`expected invalid_input, got ${result.code}`);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toContain('Missing value for "noteId"');
    expect(result.errors[0]).toContain("a scheduled run applies no input defaults");
    expect(await db.select().from(workflowDefinitions)).toHaveLength(0);
    expect(await db.select().from(workflowSchedules)).toHaveLength(0);
  });

  it("bakes a scheduled template's own default without being asked for it", async () => {
    const result = await installWorkflowTemplate(deps(), OWNER, "notes-nightly", { inputs: { noteId: "n_9" } });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.error);

    const row = (await db.select().from(workflowDefinitions))[0]!;
    const stored = JSON.stringify(row.definition);
    // Both fields are literals now, and both are gone from the schema, so
    // the nightly run reads no input at all.
    expect(stored).toContain('"id":"n_9"');
    expect(stored).toContain('"depth":3');
    expect(stored).not.toContain("trigger.data");
    expect(await db.select().from(workflowSchedules)).toHaveLength(1);
  });
});

describe("installWorkflowTemplate ownership", () => {
  it("installs into a team the caller belongs to", async () => {
    await seedTeam("team-1", [OWNER.userId]);
    const result = await installWorkflowTemplate(deps(), OWNER, "notes-echo", { teamId: "team-1" });
    expect(result.ok).toBe(true);

    const defs = await db.select().from(workflowDefinitions);
    expect(defs[0]!.ownerType).toBe("team");
    expect(defs[0]!.ownerId).toBe("team-1");
  });

  it("reports a team the caller does not belong to as not found, and writes nothing", async () => {
    await seedTeam("team-2", ["someone-else"]);
    const result = await installWorkflowTemplate(deps(), OWNER, "notes-echo", { teamId: "team-2" });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected a refusal");
    expect(result.code).toBe("team_not_found");
    expect(await db.select().from(workflowDefinitions)).toHaveLength(0);
    expect(await db.select().from(workflowVersions)).toHaveLength(0);
  });

  it("treats an unknown team the same as one the caller cannot reach", async () => {
    const result = await installWorkflowTemplate(deps(), OWNER, "notes-echo", { teamId: "team-nope" });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected a refusal");
    expect(result.code).toBe("team_not_found");
  });

  it("refuses a scheduled tool template for a team, naming the reason", async () => {
    // A scheduled run acts as the workflow's OWNER (`scheduler.ts#fire`),
    // and a team principal has no credential scope in the action invoker
    // (`plugins/action-invoker.ts#credentialOwnerFor`) — every gmail step
    // would fail on every run.
    await connect("gmail");
    await seedTeam("team-3", [OWNER.userId]);
    const result = await installWorkflowTemplate(deps(), OWNER, "gmail-sweep", { teamId: "team-3" });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected a refusal");
    expect(result.code).toBe("unsupported_owner");
    expect(result.error).toContain("gmail");
    expect(result.error).toContain("Install this template into your own workspace.");
    expect(await db.select().from(workflowSchedules)).toHaveLength(0);
  });

  it("counts repeat installs per owner, not across owners", async () => {
    await seedTeam("team-4", [OWNER.userId]);
    await installWorkflowTemplate(deps(), OWNER, "notes-echo");
    const teamInstall = await installWorkflowTemplate(deps(), OWNER, "notes-echo", { teamId: "team-4" });
    expect(teamInstall.ok).toBe(true);
    if (!teamInstall.ok) throw new Error(teamInstall.error);
    expect(teamInstall.workflowName).toBe("Notes echo");

    const teamRows = await db
      .select()
      .from(workflowDefinitions)
      .where(and(eq(workflowDefinitions.ownerType, "team"), eq(workflowDefinitions.ownerId, "team-4")));
    expect(teamRows).toHaveLength(1);
  });
});
