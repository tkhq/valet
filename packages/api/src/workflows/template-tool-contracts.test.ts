/**
 * Contract tests for the TOOL nodes in every shipped workflow template.
 *
 * `template-definitions.test.ts` pins the shapes the workflow package owns
 * — trigger, llm, orchestrator, foreach. It cannot pin a tool node: a tool
 * node's result is the integration action's own `data` payload
 * (`plugins/action-invoker.ts` returns `{ ok: true, result: result.data }`),
 * so `nodes.<id>.result.items` is only correct while `github.search_issues`
 * still returns a field called `items`. The validator cannot see that
 * either — `isKnownAction` checks the action NAME and stops there.
 *
 * That gap is the expensive one. A renamed field passes every static check,
 * installs cleanly, and then renders `null` into a prompt on the first
 * scheduled run, at 13:00, in front of whoever installed it.
 *
 * So this suite runs the real action. Each tool node is dispatched through
 * the real `buildActionInvoker` against a stubbed upstream transport, and
 * the fields the template reads are asserted against the `data` the action
 * actually produced. A field rename in a plugin fails here, in CI, with the
 * template id and the path that broke.
 *
 * Two things stay out of scope, on purpose:
 *   - An MCP-backed service (Linear) resolves its actions at run time and
 *     returns joined text, so there is no field to pin. The rule that
 *     replaces the check is asserted instead: such a node must be read
 *     WHOLE (`nodes.<id>.result`), never field-wise.
 *   - Upstream field CONTENT. The stub decides that. Only the mapping from
 *     upstream payload to `data` keys is under test, because that mapping
 *     is the part a template depends on.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { serve, type ServerType } from "@hono/node-server";
import { Hono } from "hono";
import {
  prepareActionArgs,
  type ActionPlugin,
  type CredentialOwner,
  type CredentialStore,
  type Principal,
  type StoredCredential,
  type ValetPlugin,
  type WorkflowTemplate,
} from "@valet/engine";
import {
  collectTemplatePaths,
  renderJsonTemplates,
  type TemplateContext,
  type ToolNode,
  type WorkflowDefinition,
  type WorkflowInputDefinition,
} from "@valet/workflow";
import { bundledPlugins } from "../plugins/registry.gen.js";
import { freshTestPgDb } from "../test-helpers/pg-test-db.js";
import { deriveSecretKey } from "../lib/secret-crypto.js";
import { buildActionInvoker, type ActionInvocationContext } from "../plugins/action-invoker.js";
import { toolNodesOf } from "./templates.js";

// ─── Shipped templates ───────────────────────────────────────────────────────

interface OwnedTemplate {
  pluginName: string;
  template: WorkflowTemplate;
  definition: WorkflowDefinition;
}

const owned: OwnedTemplate[] = bundledPlugins.flatMap((plugin) =>
  (plugin.templates ?? []).map((template) => ({
    pluginName: plugin.name,
    template,
    // Same narrowing `template-definitions.test.ts` documents: the manifest
    // keeps `definition` opaque so the engine gains no dependency on
    // @valet/workflow, and that suite asserts the dag/v1 shape first.
    definition: template.definition as WorkflowDefinition,
  })),
);

const actionPluginByService = new Map<string, { plugin: ValetPlugin; actionPlugin: ActionPlugin }>();
for (const plugin of bundledPlugins) {
  for (const actionPlugin of plugin.actions ?? []) {
    actionPluginByService.set(actionPlugin.service, { plugin, actionPlugin });
  }
}

/** A service whose action list only resolves with credentials in hand. */
function isDynamicService(service: string): boolean {
  return actionPluginByService.get(service)?.actionPlugin.resolveActions !== undefined;
}

// ─── What each template reads back ───────────────────────────────────────────

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function pathsInJson(value: unknown, out: string[][]): void {
  if (typeof value === "string") {
    out.push(...collectTemplatePaths(value));
    return;
  }
  if (Array.isArray(value)) {
    for (const entry of value) pathsInJson(entry, out);
    return;
  }
  if (isRecord(value)) {
    for (const entry of Object.values(value)) pathsInJson(entry, out);
  }
}

/** Every path a definition reads, `if.left` and `edge.when` included. */
function referencedPaths(definition: WorkflowDefinition): string[][] {
  const out: string[][] = [];
  for (const node of definition.nodes) {
    if (node.type === "if") {
      for (const condition of node.conditions) out.push(...collectTemplatePaths(`{{ ${condition.left} }}`));
      continue;
    }
    pathsInJson(node, out);
  }
  for (const edge of definition.edges) {
    if (edge.when !== undefined) out.push(...collectTemplatePaths(`{{ ${edge.when} }}`));
  }
  return out;
}

/**
 * Result fields the workflow engine writes itself, so no action produces
 * them and this file must not ask one to.
 *
 * A tool node with `onDeny: "skip"` completes with `{ approved, policyDenied,
 * resolvedBy, note }` when its approval gate is denied or times out
 * (`workflow/src/nodes/tool.ts`, `denyOutcome`). A definition reads those to
 * tell a refusal apart from a call that failed — which it cannot do any
 * other way, because a tolerated failure exposes `nodes.<id>.error` and the
 * validator rejects that path.
 */
const ENGINE_WRITTEN_RESULT_FIELDS = new Set(["approved", "policyDenied", "resolvedBy", "note"]);

/**
 * Field names read directly under one node's result, e.g. `items` from
 * `nodes.review_queue.result.items`. Both `result` and its legacy alias
 * `output` address the same value (`interpreter.ts` writes both).
 *
 * Engine-written fields are left out: they are real paths, but the action
 * behind the node is not what produces them.
 */
function fieldsReadFrom(definition: WorkflowDefinition, nodeId: string): string[] {
  const fields = new Set<string>();
  for (const segments of referencedPaths(definition)) {
    if (segments[0] !== "nodes" || segments[1] !== nodeId) continue;
    if (segments[2] !== "result" && segments[2] !== "output") continue;
    const field = segments[3];
    if (field !== undefined && !ENGINE_WRITTEN_RESULT_FIELDS.has(field)) fields.add(field);
  }
  return [...fields];
}

/** True when any path reads the node's result as a whole value. */
function readsWholeResult(definition: WorkflowDefinition, nodeId: string): boolean {
  return referencedPaths(definition).some(
    (segments) =>
      segments[0] === "nodes" &&
      segments[1] === nodeId &&
      (segments[2] === "result" || segments[2] === "output") &&
      segments[3] === undefined,
  );
}

// ─── Rendering a node's params without a live run ─────────────────────────────

/**
 * A tool node's params hold templates a run would resolve (`{{ item.id }}`).
 * The action's parameter schema is checked here, so those have to become
 * values of the right type first. The alias values are deliberately
 * plausible-looking: a Slack channel id must still look like one, or the
 * action's own guard rejects it for the wrong reason.
 *
 * One alias carries every field any body reads, because the bodies disagree
 * about what an item is — a Slack channel in one template, a routed pull
 * request in another.
 */
const ITEM_ALIAS: Record<string, unknown> = {
  id: "C0FIXTURE1",
  number: 42,
  slackUserId: "U0FIXTURE1",
  comment: "The area that owns these paths should read this.",
  message: "A pull request is waiting for your review.",
  // A Google calendar id is an address. The action puts it in the request
  // path, so a value that is not one fails the fixture route rather than
  // the mapping under test.
  calendarId: "reviewer-one@example.com",
};

/** What a body sees when it interpolates the WHOLE alias. One template's
 * items are bare Gmail message ids, and the object above is the wrong type
 * for a param that takes one of those. */
const WHOLE_ITEM_ALIAS = "m1";

/** A param that is exactly the item alias and nothing else. */
const WHOLE_ALIAS_PARAM = /^\s*\{\{\s*item\s*\}\}\s*$/;

/** Placeholder per declared input type, for a field with no default. */
const PLACEHOLDER_BY_TYPE: Record<WorkflowInputDefinition["type"], unknown> = {
  string: "fixture",
  number: 1,
  integer: 1,
  boolean: true,
  object: {},
  array: [],
};

/**
 * What a trigger maps into a hidden object field.
 *
 * `WorkflowInputDefinition.hidden` marks "a value a webhook maps in", and an
 * event-triggered template reads its whole subject out of one — every
 * repository, pull request and commit value in the pull-request review
 * template is a `trigger.data.payload.…` path. `{}` renders all of them
 * null, so the action's parameter schema would reject the node for a reason
 * that has nothing to do with the mapping under test.
 *
 * One object carries every key any template reads, the same way `ITEM_ALIAS`
 * does above. Today that is a GitHub `pull_request` body. Add keys when a
 * second template needs different ones.
 */
const WEBHOOK_PAYLOAD: Record<string, unknown> = {
  action: "synchronize",
  repository: {
    full_name: "acme/widgets",
    name: "widgets",
    owner: { login: "acme" },
  },
  sender: { id: 4242, login: "octocat" },
  pull_request: {
    number: 42,
    state: "open",
    draft: false,
    title: "Fix the flake in the batch suite",
    user: { login: "octocat" },
    head: { ref: "fix/flake", sha: "d3adb33fd3adb33fd3adb33fd3adb33fd3adb33f" },
    base: { ref: "main" },
  },
};

/**
 * Stand-ins for the literals install bakes into a template's params
 * (`workflows/templates.ts#bakeInputs`). A param that still reads
 * `{{ trigger.data.<field> }}` here is holding the place of one of those,
 * so the field's own `default` is used where it declares one. A field
 * without one gets a value of its declared type, which keeps the action's
 * parameter schema exercised rather than dodged by a null.
 *
 * A hidden object field is the exception: install never bakes one (it bakes
 * primitives only), because a trigger supplies it at fire time. See
 * {@link WEBHOOK_PAYLOAD}.
 */
function installedInputValues(definition: WorkflowDefinition): Record<string, unknown> {
  const trigger = definition.nodes.find((node) => node.type === "trigger");
  const schema = trigger?.type === "trigger" ? trigger.dataSchema : undefined;
  const values: Record<string, unknown> = {};
  for (const [field, def] of Object.entries(schema ?? {})) {
    if (def.hidden === true && def.type === "object" && def.default === undefined) {
      values[field] = WEBHOOK_PAYLOAD;
      continue;
    }
    values[field] = def.default !== undefined ? def.default : PLACEHOLDER_BY_TYPE[def.type];
  }
  return values;
}

/**
 * Upstream node results a tool node's params read.
 *
 * A param that names an earlier node has to render to a value of the right
 * type, or the action's parameter schema rejects it for a reason that is
 * not the mapping under test. A single-expression param keeps the value's
 * type, so an enum-valued param needs a real member of that enum and an
 * array-valued param needs a real array.
 *
 * Keyed by node id and shared across templates, the way `ITEM_ALIAS` is.
 * Both `result` and its alias `output` carry the same value, because a
 * template may address either (`interpreter.ts` writes both).
 */
const NODE_RESULTS: Record<string, unknown> = {
  classify: { output: { labelId: "Label_7" } },
  // The review template's llm node. `verdict` must be one of the two the
  // create_review action accepts, and `findings` must be the array of
  // anchors it posts, not their JSON text.
  review: {
    text: "",
    output: {
      verdict: "REQUEST_CHANGES",
      summary: "Retries the flaky case. One retry has no ceiling.",
      findings: [
        {
          path: "packages/api/src/batch.test.ts",
          line: 2,
          body: "**Major** — the retry loop has no ceiling. Give it a maximum attempt count.",
        },
      ],
      findingsMarkdown: "- **Major** `packages/api/src/batch.test.ts:2` — the retry loop has no ceiling.",
      unreadFiles: "none",
    },
    usage: {},
  },
  // The review template's inspect node, which pins the review to the SHA
  // the diff was read at.
  inspect: {
    number: 42,
    changed_files: 1,
    matched_file_count: 1,
    head: { ref: "fix/flake", sha: "d3adb33fd3adb33fd3adb33fd3adb33fd3adb33f" },
    patch_summary: { limit_bytes: 120000, included_bytes: 24, truncated_files: 0, omitted_files: 0 },
  },
  // The assign-reviewers template's selection node. `assignees` must be the
  // array `github.update_pull_request` writes, not its JSON text, because a
  // single-expression param keeps the value's type.
  select: {
    text: "",
    output: {
      assignees: ["reviewer-one"],
      failureReason: "Every required owner is covered.",
    },
    usage: {},
  },
  // The same template's read-back comparison node.
  confirm: {
    text: "",
    output: { summary: "Assigned reviewer-one for @example-org/group-one." },
    usage: {},
  },
};

function paramRenderContext(definition: WorkflowDefinition): TemplateContext {
  const nodes: Record<string, { result: unknown; output: unknown }> = {};
  for (const [id, result] of Object.entries(NODE_RESULTS)) nodes[id] = { result, output: result };
  return {
    trigger: {
      type: "manual",
      timestamp: "2026-08-15T00:00:00.000Z",
      data: installedInputValues(definition),
      metadata: {},
    },
    nodes,
    item: ITEM_ALIAS,
    index: 0,
  };
}

function renderedParams(node: ToolNode, definition: WorkflowDefinition): Record<string, unknown> {
  const rendered = renderJsonTemplates<Record<string, unknown>>(node.params, paramRenderContext(definition));
  // Substitute the string form of the alias only where the whole alias was
  // interpolated — the source template says which, so nothing has to be
  // guessed from the rendered value's shape.
  for (const [key, source] of Object.entries(node.params)) {
    if (typeof source === "string" && WHOLE_ALIAS_PARAM.test(source)) rendered[key] = WHOLE_ITEM_ALIAS;
  }
  return rendered;
}

// ─── Upstream fixtures ────────────────────────────────────────────────────────

/**
 * One realistic upstream payload per action a template calls. These stand
 * in for the vendor API, so they carry the vendor's OWN field names — the
 * action's mapping from these to its `data` keys is what the assertions
 * below actually exercise.
 */
const GMAIL_MESSAGE = {
  id: "m1",
  threadId: "t1",
  labelIds: ["INBOX", "UNREAD"],
  snippet: "quarterly newsletter",
  payload: {
    headers: [
      { name: "From", value: "news@example.com" },
      { name: "Subject", value: "Weekly roundup" },
      { name: "To", value: "reader@example.com" },
      { name: "Date", value: "Fri, 14 Aug 2026 09:00:00 +0000" },
      { name: "List-Unsubscribe", value: "<mailto:unsub@example.com>" },
    ],
    body: { data: Buffer.from("Nothing needs your reply.").toString("base64url") },
  },
};

const SEARCH_ISSUES_BODY = {
  total_count: 1,
  items: [
    {
      number: 42,
      title: "Fix the flake in the batch suite",
      state: "open",
      user: { login: "octocat" },
      html_url: "https://github.test/acme/widgets/pull/42",
      pull_request: { url: "https://api.github.test/pulls/42" },
      labels: [{ name: "bug" }],
      created_at: "2026-08-01T00:00:00Z",
      updated_at: "2026-08-02T00:00:00Z",
    },
  ],
};

/** `GET /repos/{owner}/{repo}/pulls/{n}` — the whole pull request, which is
 * where the reviewer-claim fields live. */
const PULL_REQUEST_BODY = {
  number: 42,
  title: "Fix the flake in the batch suite",
  state: "open",
  merged: false,
  draft: false,
  user: { login: "octocat" },
  html_url: "https://github.test/acme/widgets/pull/42",
  body: "Retries the one case that fails under load.",
  additions: 12,
  deletions: 3,
  changed_files: 1,
  requested_reviewers: [],
  requested_teams: [],
  assignees: [],
  head: { ref: "fix/flake", sha: "d3adb33fd3adb33fd3adb33fd3adb33fd3adb33f" },
  base: { ref: "main" },
};

const PULL_REQUEST_FILES = [
  {
    filename: "packages/api/src/batch.test.ts",
    status: "modified",
    additions: 12,
    deletions: 3,
    patch: "@@ -1,2 +1,2 @@",
  },
];

/** `GET /repos/{owner}/{repo}/contents/{path}` — base64, the way GitHub
 * sends a file, so the action's own decode runs. */
const REPO_FILE_TEXT = ["path_prefix,area,github_handle,slack_user_id", "packages/api/,api,fixture,U0FIXTURE1"].join(
  "\n",
);

const REPO_FILE_BODY = {
  type: "file",
  encoding: "base64",
  path: ".github/reviewer-routing.csv",
  size: REPO_FILE_TEXT.length,
  content: Buffer.from(REPO_FILE_TEXT).toString("base64"),
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

/** `GET /calendars/{id}/events` — the vendor's own field names, so the
 * action's mapping from these to its `data` keys is what runs. One event
 * that reads as time away from work, because that is the only kind the
 * template asks the calendar about. */
const CALENDAR_EVENTS_BODY = {
  items: [
    {
      id: "evt_fixture_1",
      status: "confirmed",
      summary: "Away",
      start: { date: "2026-08-15" },
      end: { date: "2026-08-18" },
      attendees: [{ email: "reviewer-one@example.com", responseStatus: "accepted" }],
      organizer: { email: "reviewer-one@example.com" },
      htmlLink: "https://calendar.google.test/event?eid=evt_fixture_1",
    },
  ],
};

/**
 * Serves Google Calendar, Slack and Gmail from one router.
 *
 * GitHub is NOT served here. Its actions go through Octokit, which uses the
 * same global `fetch` this replaces, so a loopback fixture is only
 * reachable if unmatched hosts fall through to the real implementation —
 * which is what the last branch does.
 *
 * An unmatched Slack method returns an `ok: true` envelope rather than a
 * 404: an action makes secondary calls (a private-channel guard, a user
 * lookup) that are not what is under test, and a hard failure there would
 * hide the mapping assertion behind an unrelated error.
 */
function stubUpstream(): void {
  const realFetch = globalThis.fetch;
  vi.stubGlobal("fetch", async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;

    if (url.includes("googleapis.com/calendar/v3/calendars/")) {
      return json(CALENDAR_EVENTS_BODY);
    }

    if (url.includes("/gmail/v1/users/me/labels")) {
      return json({ labels: [{ id: "Label_7", name: "Bulk", type: "user" }] });
    }
    if (url.includes("/gmail/v1/users/me/messages/") && url.includes("/modify")) {
      return json({ id: "m1", threadId: "t1", labelIds: ["Label_7"] });
    }
    if (url.includes("/gmail/v1/users/me/messages/")) {
      return json(GMAIL_MESSAGE);
    }
    if (url.includes("/gmail/v1/users/me/messages")) {
      return json({ messages: [{ id: "m1" }], resultSizeEstimate: 1 });
    }

    if (url.includes("slack.com/api/users.conversations") || url.includes("slack.com/api/conversations.list")) {
      return json({
        ok: true,
        channels: [{ id: "C0FIXTURE1", name: "eng-platform", is_private: false, num_members: 12 }],
      });
    }
    if (url.includes("slack.com/api/conversations.open")) {
      // A DM action reads `channel.id` off this and fails without it, so the
      // generic `ok: true` envelope below is not enough.
      return json({ ok: true, channel: { id: "D0FIXTURE1" } });
    }
    if (url.includes("slack.com/api/conversations.info")) {
      return json({ ok: true, channel: { id: "C0FIXTURE1", name: "eng-platform", is_private: false } });
    }
    if (url.includes("slack.com/api/conversations.history")) {
      return json({
        ok: true,
        has_more: false,
        messages: [
          { type: "message", ts: "1774000000.000100", user: "U1", text: "shipping the gallery", reply_count: 2 },
        ],
      });
    }
    if (url.includes("slack.com/api/")) return json({ ok: true });

    return realFetch(input, init);
  });
}

/**
 * A loopback GitHub the plugin's Octokit reaches through `GITHUB_API_URL`.
 *
 * The catch-all answers `{}`, which is enough for an action that returns
 * the raw payload and reads nothing out of it. Every route below exists
 * because `{}` is NOT enough: an action reads a field off the response, or
 * iterates it, and would fail for a reason that has nothing to do with the
 * mapping under test.
 */
function startGithubFixture(): { url: string; close: () => Promise<void> } {
  const app = new Hono();
  app.get("/search/issues", (c) => c.json(SEARCH_ISSUES_BODY));
  // `inspect_pull_request` makes four calls. The file list is the one it
  // deliberately does not guard, because an empty list would read as "this
  // pull request touches nothing".
  app.get("/repos/:owner/:repo/pulls/:pullNumber/files", (c) => c.json(PULL_REQUEST_FILES));
  app.get("/repos/:owner/:repo/pulls/:pullNumber/reviews", (c) => c.json([]));
  // `create_review` reads the id, the state and the url off the response,
  // and a template reads `review_id` back to tell an accepted review from a
  // rejected one.
  app.post("/repos/:owner/:repo/pulls/:pullNumber/reviews", (c) =>
    c.json({
      id: 990011,
      state: "CHANGES_REQUESTED",
      html_url: "https://github.test/acme/widgets/pull/42#pullrequestreview-990011",
    }),
  );
  app.get("/repos/:owner/:repo/pulls/:pullNumber/comments", (c) => c.json([]));
  app.get("/repos/:owner/:repo/pulls/:pullNumber", (c) => c.json(PULL_REQUEST_BODY));
  app.get("/repos/:owner/:repo/commits/:ref/check-runs", (c) => c.json({ check_runs: [] }));
  // A file path holds slashes, which a plain `:path` segment refuses.
  app.get("/repos/:owner/:repo/contents/:path{.+}", (c) => c.json(REPO_FILE_BODY));
  app.all("*", (c) => c.json({}));
  const server: ServerType = serve({ fetch: app.fetch, port: 0 });
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("no port assigned");
  return {
    url: `http://127.0.0.1:${address.port}`,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
      }),
  };
}

// ─── Invoker wiring ───────────────────────────────────────────────────────────

/** Enough of a `CredentialStore` to let each service resolve one token. */
class SeededCredentialStore implements CredentialStore {
  private readonly rows = new Map<string, StoredCredential>();

  private key(owner: CredentialOwner, service: string): string {
    return `${owner.type}:${owner.id}:${service}`;
  }

  seed(owner: CredentialOwner, service: string, credential: StoredCredential): void {
    this.rows.set(this.key(owner, service), credential);
  }

  async get(owner: CredentialOwner, service: string): Promise<StoredCredential | null> {
    return this.rows.get(this.key(owner, service)) ?? null;
  }

  async save(owner: CredentialOwner, service: string, credential: StoredCredential): Promise<void> {
    this.rows.set(this.key(owner, service), credential);
  }

  async delete(owner: CredentialOwner, service: string): Promise<void> {
    this.rows.delete(this.key(owner, service));
  }

  async list(): Promise<{ service: string; scopes?: string[]; connectedAt: string }[]> {
    return [];
  }
}

/** Credential lookups key on this; the run's ownership `Principal` is a
 * separate vocabulary that happens to agree for a personal workflow. */
const OWNER: CredentialOwner = { type: "user", id: "u1" };
const RUN_OWNER: Principal = { type: "user", id: "u1" };
const CTX: ActionInvocationContext = { userId: "u1", orgId: "org1", owner: RUN_OWNER };

async function buildInvoker(): Promise<ReturnType<typeof buildActionInvoker>> {
  const { appDb } = await freshTestPgDb();
  const credentials = new SeededCredentialStore();
  for (const service of ["github", "gmail", "slack", "google_calendar"]) {
    credentials.seed(OWNER, service, {
      type: "oauth2",
      accessToken: `${service}-fixture-token`,
      // `slack.dm_owner` resolves the owner's Slack id off the credential and
      // refuses to send without one. Every other action here ignores this.
      metadata: { owner_slack_user_id: "U0FIXTUREOWNER" },
    });
  }
  // The availability gate (integration-availability design) requires a
  // configured deployment: slack needs the org credential an admin connects,
  // and gmail needs the Google OAuth client env vars (set in beforeAll).
  credentials.seed({ type: "org", id: CTX.orgId }, "slack", {
    type: "bot_token",
    accessToken: "slack-org-fixture-token",
  });
  return buildActionInvoker({
    db: appDb,
    credentials,
    actionPluginByService,
    githubTokenDeps: { key: deriveSecretKey("template-tool-contract-test-secret") },
  });
}

// ─── The tool nodes under test ────────────────────────────────────────────────

interface ToolCase {
  templateId: string;
  definition: WorkflowDefinition;
  node: ToolNode;
  fields: string[];
}

const toolCases: ToolCase[] = owned.flatMap(({ template, definition }) =>
  toolNodesOf(definition).map((node) => ({
    templateId: template.id,
    definition,
    node,
    fields: fieldsReadFrom(definition, node.id),
  })),
);

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("shipped templates: tool node contracts", () => {
  // Built once. `freshTestPgDb` resets one process-wide PGlite instance, so
  // a per-test rebuild would be both slow and a trap (see its own warning).
  let invoke: ReturnType<typeof buildActionInvoker>;
  let githubFixture: { url: string; close: () => Promise<void> } | undefined;
  const previousGithubApiUrl = process.env.GITHUB_API_URL;
  const previousGoogleEnv = {
    GOOGLE_CLIENT_ID: process.env.GOOGLE_CLIENT_ID,
    GOOGLE_CLIENT_SECRET: process.env.GOOGLE_CLIENT_SECRET,
  };

  beforeAll(async () => {
    invoke = await buildInvoker();
    githubFixture = startGithubFixture();
    process.env.GITHUB_API_URL = githubFixture.url;
    // gmail's availability requires the OAuth client env (see buildInvoker).
    process.env.GOOGLE_CLIENT_ID = "google-fixture-client-id";
    process.env.GOOGLE_CLIENT_SECRET = "google-fixture-client-secret";
    stubUpstream();
  });

  afterAll(async () => {
    vi.unstubAllGlobals();
    await githubFixture?.close();
    githubFixture = undefined;
    if (previousGithubApiUrl === undefined) delete process.env.GITHUB_API_URL;
    else process.env.GITHUB_API_URL = previousGithubApiUrl;
    for (const [name, value] of Object.entries(previousGoogleEnv)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  });

  it("has tool nodes to check", () => {
    expect(toolCases.length).toBeGreaterThan(0);
  });

  it("reads an MCP-backed node whole, never a field under it", () => {
    // An MCP action returns joined text (`sdk/src/mcp/action-plugin.ts`
    // `mapToolResult`), so `result` is a STRING. `result.<anything>` is
    // null at run time and nothing catches it earlier.
    const wrong: string[] = [];
    for (const { templateId, node, fields } of toolCases) {
      if (!isDynamicService(node.service)) continue;
      for (const field of fields) {
        wrong.push(`${templateId}: nodes.${node.id}.result.${field} — ${node.service} returns text, not an object`);
      }
    }
    expect(wrong).toEqual([]);
  });

  it("reads something back from every MCP-backed node it runs", () => {
    // The mirror of the rule above: a node whose result is never read is a
    // step that costs a call and feeds nothing.
    const unused: string[] = [];
    for (const { templateId, node } of toolCases) {
      if (!isDynamicService(node.service)) continue;
      const definition = owned.find((o) => o.template.id === templateId)?.definition;
      if (definition === undefined) continue;
      if (!readsWholeResult(definition, node.id)) unused.push(`${templateId}: nodes.${node.id}`);
    }
    expect(unused).toEqual([]);
  });

  describe.each(toolCases.filter((c) => !isDynamicService(c.node.service)))(
    "$templateId → $node.id",
    ({ templateId, definition, node, fields }) => {
      it("sends params the action's own schema accepts", () => {
        const entry = actionPluginByService.get(node.service);
        expect(entry).toBeDefined();
        const qualified = `${node.service}.${node.action}`;
        const action = entry?.actionPlugin.actions.find((a) => a.id === qualified || a.id === node.action);
        expect(action).toBeDefined();
        if (!action) return;
        const prepared = prepareActionArgs(action.parameters, renderedParams(node, definition));
        expect(prepared.ok ? null : prepared.error).toBeNull();
      });

      it("produces the fields the template reads back", async () => {
        const response = await invoke(
          {
            service: node.service,
            action: node.action,
            params: renderedParams(node, definition),
            // The invoker dedupes by `invocationId` and two templates reuse
            // a node id, so the template must be part of the key or the
            // second case silently replays the first one's result.
            invocationId: `contract:${templateId}:${node.id}`,
            // `app` becomes `user` here. That selection mints an
            // installation token and throws when no GitHub App is installed
            // for the params owner, which this fixture has none of — and
            // the failure would land on the field-mapping assertion below,
            // which is not what it tests. Identity selection has its own
            // coverage in `plugins/action-invoker.test.ts`, both the
            // resolving and the loud-failure paths.
            credential: node.credential === "app" ? "user" : node.credential,
          },
          CTX,
        );

        // Print the action's own error rather than a bare `false` — it is
        // the only thing that says which upstream call the stub missed.
        expect(response.ok ? null : "error" in response ? response.error : "no error detail").toBeNull();
        if (!response.ok) return;

        const data = response.result;
        expect(isRecord(data)).toBe(true);
        if (!isRecord(data)) return;

        const missing = fields.filter((field) => data[field] === undefined);
        expect(missing).toEqual([]);
      });
    },
  );
});
