/**
 * Contract tests for this plugin's workflow templates, and for the
 * pull-request review template in particular.
 *
 * `packages/api`'s template suites already run the real definition
 * validator over every plugin template. What they cannot run is a GitHub
 * webhook body, and the review template is built entirely out of one: every
 * repository, pull request and commit value it reads comes from
 * `trigger.data.payload.…`. A path that names a key GitHub does not send
 * passes the validator, passes the api suites, and then renders empty on the
 * first real pull request. This file closes that gap by rendering the
 * definition against a payload shaped the way the dispatcher delivers one.
 *
 * It also pins the invariants of `github.create_review` that a definition
 * can break silently: the action refuses `updateExisting` together with
 * inline comments, and it offers no approving verdict.
 */
import { describe, expect, it } from "vitest";
import {
  collectTemplatePaths,
  collectUnresolvedTemplatePaths,
  evaluateExpression,
  isIfOperationSupported,
  parseExpression,
  renderJsonTemplates,
  renderTemplate,
  validateWorkflowDefinition,
  type IfCondition,
  type IfNode,
  type LlmNode,
  type TemplateContext,
  type ToolNode,
  type ValidateEnvironment,
  type WorkflowDefinition,
  type WorkflowTriggerPayload,
} from "@valet/workflow";
import { extractStructuredOutput, type WorkflowTemplate } from "@valet/engine";
import { githubPlugin } from "./actions/actions.js";
import { githubTemplates } from "./templates.js";
import { githubTriggerDefs } from "./triggers.js";

// ─── Environment ─────────────────────────────────────────────────────────

/** The real action list, so a renamed or dropped action fails here. The
 * model hook stays out: `packages/api` owns the model catalog, and its own
 * template suite runs the same definitions with it. */
const env: ValidateEnvironment = {
  isKnownAction: (service, action) => {
    if (service !== githubPlugin.service) return "unknown-service";
    const qualified = `${service}.${action}`;
    return githubPlugin.actions.some((a) => a.id === qualified || a.id === action)
      ? "ok"
      : "unknown-action";
  },
};

function templateById(id: string): WorkflowTemplate {
  const found = githubTemplates.find((t) => t.id === id);
  if (!found) throw new Error(`no github template with id "${id}"`);
  return found;
}

function definitionOf(id: string): WorkflowDefinition {
  // `WorkflowTemplate.definition` is `unknown` so the engine gains no
  // dependency on @valet/workflow. The shape assertion runs as its own
  // test below, before anything reads `.nodes`.
  return templateById(id).definition as WorkflowDefinition;
}

const REVIEW_ID = "github.pull-request-review";

// ─── Path collection ─────────────────────────────────────────────────────

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Every template SOURCE string a definition holds, with the bare
 * expressions (`if.left`, `edge.when`) wrapped so one parser sees them all.
 *
 * An `exists` condition is wrapped as `exists(...)` rather than as a plain
 * read, because that is what the condition means: asking whether a path is
 * there is the one place a missing path is the question and not a fault.
 * `collectUnresolvedTemplatePaths` skips `exists(...)` for that reason,
 * while `collectTemplatePaths` still returns the path — so a condition
 * keeps its trigger-key coverage without having to resolve. */
interface TemplateSource {
  nodeId: string;
  source: string;
}

function sourcesInJson(nodeId: string, value: unknown, out: TemplateSource[]): void {
  if (typeof value === "string") {
    if (value.includes("{{")) out.push({ nodeId, source: value });
    return;
  }
  if (Array.isArray(value)) {
    for (const entry of value) sourcesInJson(nodeId, entry, out);
    return;
  }
  if (isRecord(value)) {
    for (const entry of Object.values(value)) sourcesInJson(nodeId, entry, out);
  }
}

function templateSources(definition: WorkflowDefinition): TemplateSource[] {
  const out: TemplateSource[] = [];
  for (const node of definition.nodes) {
    if (node.type === "if") {
      for (const condition of node.conditions) {
        const probes = condition.operation === "exists" || condition.operation === "doesNotExist";
        const source = probes ? `{{ exists(${condition.left}) }}` : `{{ ${condition.left} }}`;
        out.push({ nodeId: node.id, source });
      }
      continue;
    }
    sourcesInJson(node.id, node, out);
  }
  for (const edge of definition.edges) {
    if (edge.when !== undefined) {
      out.push({ nodeId: `${edge.from}->${edge.to}`, source: `{{ ${edge.when} }}` });
    }
  }
  return out;
}

function pathsOf(definition: WorkflowDefinition): string[] {
  return templateSources(definition).flatMap((entry) =>
    collectTemplatePaths(entry.source).map((segments) => segments.join(".")),
  );
}

function nodeOf(definition: WorkflowDefinition, id: string): unknown {
  return definition.nodes.find((node) => node.id === id);
}

function toolNode(definition: WorkflowDefinition, id: string): ToolNode {
  // `nodes` is a discriminated union, so `type` narrows it without a cast.
  const node = definition.nodes.find((n): n is ToolNode => n.type === "tool" && n.id === id);
  if (!node) throw new Error(`no tool node "${id}"`);
  return node;
}

// ─── Fixtures ────────────────────────────────────────────────────────────

const HEAD_SHA = "1c9f0e3a5b7d2f4061829304a5b6c7d8e9f00112";
const REPO_OWNER = "example-org";
const REPO_NAME = "example-service";
const PR_NUMBER = 4211;

/** A `pull_request` webhook body, cut down to the keys this template reads
 * plus the ones the trigger normalizer reads. Every value is present, so a
 * path that fails to resolve against it names a key GitHub does not send. */
function webhookBody(action: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    action,
    number: PR_NUMBER,
    repository: {
      full_name: `${REPO_OWNER}/${REPO_NAME}`,
      name: REPO_NAME,
      owner: { login: REPO_OWNER },
    },
    sender: { id: 4242, login: "an-engineer" },
    pull_request: {
      number: PR_NUMBER,
      state: "open",
      draft: false,
      title: "Cache the settings lookup",
      user: { login: "an-engineer" },
      head: { ref: "cache-settings", sha: HEAD_SHA },
      base: { ref: "main" },
      updated_at: "2026-08-17T09:30:00Z",
      ...overrides,
    },
  };
}

/**
 * The trigger payload an event delivery produces, built the way
 * `api/src/events/dispatcher.ts#startWorkflow` builds one: the whole webhook
 * body under `data.payload`, the pre-extracted refs beside it, and the
 * subscription id as `triggerId`.
 */
function eventTrigger(body: Record<string, unknown>): WorkflowTriggerPayload {
  const repository = body.repository as { full_name: string };
  return {
    type: "event",
    triggerId: "evtsub_01",
    timestamp: "2026-08-17T09:30:01.000Z",
    data: {
      key: `github.pull_request.${String(body.action)}`,
      summary: `${repository.full_name} — pull_request ${String(body.action)} by an-engineer`,
      refs: { repo: repository.full_name, installation_id: "77" },
      payload: body,
    },
    metadata: { eventId: "evt_01", service: "github" },
  };
}

/** `inspect_pull_request`'s `data`, with the diff attached — the shape the
 * action returns when `includePatch` is set. */
function inspectResult(): Record<string, unknown> {
  return {
    number: PR_NUMBER,
    title: "Cache the settings lookup",
    state: "open",
    merged: false,
    draft: false,
    user: "an-engineer",
    url: `https://github.com/${REPO_OWNER}/${REPO_NAME}/pull/${PR_NUMBER}`,
    requested_reviewers: [],
    requested_teams: [],
    assignees: [],
    head: { ref: "cache-settings", sha: HEAD_SHA },
    base: { ref: "main" },
    body: "Reads the settings row once per request instead of once per field.",
    additions: 42,
    deletions: 11,
    changed_files: 3,
    files: [
      {
        filename: "src/settings.ts",
        status: "modified",
        additions: 30,
        deletions: 8,
        patch: "@@ -10,6 +10,7 @@\n+  const cached = cache.get(key);\n",
      },
    ],
    matched_file_count: 3,
    files_complete: true,
    patch_summary: { limit_bytes: 120000, included_bytes: 640, truncated_files: 0, omitted_files: 0 },
    reviews: [],
    comments: [],
    checks: [],
  };
}

/** The review llm node's structured output. */
function reviewOutput(verdict: "COMMENT" | "REQUEST_CHANGES"): Record<string, unknown> {
  return {
    verdict,
    summary: "Caches the settings row per request. One cache key is built from mutable state.",
    findings: [
      {
        path: "src/settings.ts",
        line: 11,
        body: "**Blocker** — the cache key omits the tenant id, so one tenant reads another's settings. Add the tenant id to the key.",
      },
    ],
    findingsMarkdown:
      "- **Blocker** `src/settings.ts:11` — the cache key omits the tenant id. Add it to the key.",
  };
}

/** A context in which every node of the review template has completed. One
 * fixture covers both posting branches: the fallback reads only values the
 * successful branch also produces. */
function fullContext(
  trigger: WorkflowTriggerPayload,
  verdict: "COMMENT" | "REQUEST_CHANGES" = "REQUEST_CHANGES",
  /** Node results to replace, for the branches the happy path cannot show:
   * a diff the byte budget cut short, or a posting step a person denied.
   * Merged here rather than spread at the call site, because
   * `TemplateContext.nodes` is `unknown` and spreading it is unsound. */
  nodeOverrides: Record<string, { result: unknown }> = {},
): TemplateContext {
  const inspect = { result: inspectResult() };
  const review = { result: { text: "", output: reviewOutput(verdict), usage: {} } };
  const recheck = { result: inspectResult() };
  const post = {
    result: {
      review_id: 990011,
      state: "CHANGES_REQUESTED",
      url: `https://github.com/${REPO_OWNER}/${REPO_NAME}/pull/${PR_NUMBER}#pullrequestreview-990011`,
      updated: false,
      inline_comments: 1,
    },
  };
  return {
    trigger,
    nodes: {
      inspect,
      review,
      recheck_head: recheck,
      post_review: post,
      report_too_large: { result: { review_id: 1, state: "COMMENTED", url: "", updated: true, inline_comments: 0 } },
      post_review_body_only: { result: { review_id: 2, state: "CHANGES_REQUESTED", url: "", updated: false, inline_comments: 0 } },
      ...nodeOverrides,
    },
  };
}

// ─── Every template ──────────────────────────────────────────────────────

/** Templates this package can validate on its own. The routing template
 * also calls Slack, and only `packages/api` loads every plugin, so its own
 * suite is where a cross-service definition is validated. */
const githubOnly = githubTemplates.filter((template) => {
  const definition = template.definition as WorkflowDefinition;
  return definition.nodes.every((node) => {
    if (node.type === "tool") return node.service === githubPlugin.service;
    if (node.type === "foreach" && node.body.type === "tool") return node.body.service === githubPlugin.service;
    return true;
  });
});

describe("github workflow templates", () => {
  it("ships the pull-request review template", () => {
    expect(githubTemplates.map((t) => t.id)).toContain(REVIEW_ID);
  });

  it("validates the review template here, not only through the api suite", () => {
    expect(githubOnly.map((t) => t.id)).toContain(REVIEW_ID);
  });

  describe.each(githubOnly)("$id", (template) => {
    it("passes the definition validator against the real action list", () => {
      const result = validateWorkflowDefinition(template.definition as WorkflowDefinition, env);
      // The validator's own messages name the node and the corrected path.
      expect(result.ok ? [] : result.errors).toEqual([]);
    });
  });
});

// ─── The review template ─────────────────────────────────────────────────

describe(REVIEW_ID, () => {
  const definition = definitionOf(REVIEW_ID);
  const template = templateById(REVIEW_ID);

  it("carries a dag/v1 definition", () => {
    expect(definition.version).toBe("dag/v1");
    expect(definition.nodes.length).toBeGreaterThan(0);
    expect(definition.edges.length).toBeGreaterThan(0);
  });

  it("arms no schedule, because a review starts from a pull request and not from a clock", () => {
    expect(template.schedule).toBeUndefined();
  });

  it("collects nothing at install, so no unbaked reference can survive it", () => {
    const trigger = definition.nodes.find((node) => node.type === "trigger");
    expect(trigger?.type).toBe("trigger");
    const schema = trigger?.type === "trigger" ? trigger.dataSchema : undefined;
    // One field, and it is hidden: `templateInputs` drops hidden and
    // non-primitive fields, so the install dialog shows no form at all.
    // Anything visible here would be a value install bakes only when the
    // caller supplies it, and a direct API install supplies nothing.
    expect(Object.keys(schema ?? {})).toEqual(["payload"]);
    expect(schema?.payload?.hidden).toBe(true);
    expect(schema?.payload?.type).toBe("object");
    // Not required: the field is never typed by a person, so a required
    // field would refuse a manual run with an error nobody can act on.
    expect(schema?.payload?.required).toBeUndefined();
  });

  it("fails a node rather than render a hole, when the payload is absent", () => {
    expect(definition.policy?.onUnresolvedPath).toBe("fail");
  });

  it("names the trigger to add in the message it stops with", () => {
    const stop = nodeOf(definition, "no_pull_request");
    expect(isRecord(stop) && stop.type).toBe("stop");
    const message = isRecord(stop) && typeof stop.message === "string" ? stop.message : "";
    expect(message).toContain("github.pull_request.opened");
    expect(message).toContain("github.pull_request.synchronize");
    expect(message).toContain("github.pull_request.reopened");
    expect(message).toContain("github.pull_request.ready_for_review");
    // The message must not read the payload it exists to report missing.
    expect(collectTemplatePaths(message)).toEqual([]);
  });

  it("subscribes to event keys the github trigger catalog actually offers", () => {
    const stop = nodeOf(definition, "no_pull_request");
    const message = isRecord(stop) && typeof stop.message === "string" ? stop.message : "";
    const keys = message.match(/github\.pull_request\.[a-z_]+/g) ?? [];
    expect(keys.length).toBe(4);
    const catalog = new Set(
      githubTriggerDefs.flatMap((def) => (def.catalog ?? []).map((entry) => entry.key)),
    );
    expect(keys.filter((key) => !catalog.has(key))).toEqual([]);
  });
});

// ─── Trigger-path resolution ─────────────────────────────────────────────

describe(`${REVIEW_ID} — paths`, () => {
  const definition = definitionOf(REVIEW_ID);

  it("reads only trigger-payload keys the run host delivers", () => {
    const allowed = new Set(["type", "triggerId", "timestamp", "data", "metadata"]);
    const wrong = pathsOf(definition)
      .map((path) => path.split("."))
      .filter((segments) => segments[0] === "trigger")
      .filter((segments) => segments.length > 1 && !allowed.has(segments[1] ?? ""))
      .map((segments) => segments.join("."));
    expect(wrong).toEqual([]);
  });

  it("resolves every path against a real pull_request delivery", () => {
    const ctx = fullContext(eventTrigger(webhookBody("synchronize")));
    const unresolved: string[] = [];
    for (const entry of templateSources(definition)) {
      for (const path of collectUnresolvedTemplatePaths(entry.source, ctx)) {
        unresolved.push(`${entry.nodeId}: ${path}`);
      }
    }
    expect(unresolved).toEqual([]);
  });

  it("resolves the same paths for every pull_request action it subscribes to", () => {
    const ctx = (action: string): TemplateContext => fullContext(eventTrigger(webhookBody(action)));
    for (const action of ["opened", "synchronize", "reopened", "ready_for_review"]) {
      const unresolved = templateSources(definition).flatMap((entry) =>
        collectUnresolvedTemplatePaths(entry.source, ctx(action)),
      );
      expect({ action, unresolved }).toEqual({ action, unresolved: [] });
    }
  });

  it("leaves nothing to resolve when the run carries no webhook body", () => {
    // The point of `onUnresolvedPath: "fail"`. A hand-started run reaches
    // the first `if` node — which is exempt — and stops there with the
    // corrective message, so no later node ever renders.
    const ctx: TemplateContext = {
      trigger: { type: "manual", triggerId: undefined, timestamp: "2026-08-17T09:30:01.000Z", data: {}, metadata: {} },
      nodes: {},
    };
    const gate = nodeOf(definition, "started_by_event");
    expect(isRecord(gate) && gate.type).toBe("if");
    const conditions = isRecord(gate) && Array.isArray(gate.conditions) ? gate.conditions : [];
    expect(conditions.length).toBe(1);
    const inspectParams = toolNode(definition, "inspect").params;
    const holes = Object.values(inspectParams).flatMap((value) =>
      typeof value === "string" ? collectUnresolvedTemplatePaths(value, ctx) : [],
    );
    // Every one of these is a path the policy fails the node on, rather
    // than a null it sends to GitHub.
    expect(holes.length).toBeGreaterThan(0);
  });
});

// ─── What the posting steps hand to GitHub ───────────────────────────────

describe(`${REVIEW_ID} — create_review calls`, () => {
  const definition = definitionOf(REVIEW_ID);

  function reviewNodes(): ToolNode[] {
    return definition.nodes
      .filter((node): node is ToolNode => node.type === "tool")
      .filter((node) => node.action === "create_review");
  }

  it("posts as the installed application, never as the workflow owner", () => {
    const asUser = definition.nodes
      .filter((node): node is ToolNode => node.type === "tool")
      .filter((node) => node.credential !== "app")
      .map((node) => node.id);
    expect(asUser).toEqual([]);
  });

  it("never asks for an approving verdict", () => {
    const review = definition.nodes.find((node): node is LlmNode => node.type === "llm");
    const schema = review?.outputSchema;
    const properties = isRecord(schema) && isRecord(schema.properties) ? schema.properties : {};
    const verdict = properties.verdict;
    const values = isRecord(verdict) && Array.isArray(verdict.enum) ? verdict.enum : [];
    expect(values).toEqual(["COMMENT", "REQUEST_CHANGES"]);
    // The action refuses APPROVE outright, so a definition that asked for
    // it would fail on every blocking review.
    for (const node of reviewNodes()) {
      expect(JSON.stringify(node.params)).not.toContain("APPROVE");
    }
  });

  it("never combines updateExisting with inline comments", () => {
    // `github.create_review` refuses that pair: GitHub's review-update
    // endpoint changes the summary body only, so the comments would be
    // lost. A definition that sets both fails on every run.
    const broken = reviewNodes()
      .filter((node) => node.params.updateExisting === true && node.params.comments !== undefined)
      .map((node) => node.id);
    expect(broken).toEqual([]);
  });

  it("gives every review an update key when it updates in place", () => {
    for (const node of reviewNodes()) {
      if (node.params.updateExisting !== true) continue;
      expect(typeof node.params.updateKey).toBe("string");
    }
  });

  it("renders the inline review into the shape the action takes", () => {
    const ctx = fullContext(eventTrigger(webhookBody("synchronize")), "REQUEST_CHANGES");
    const rendered = renderJsonTemplates(toolNode(definition, "post_review").params, ctx);
    expect(isRecord(rendered)).toBe(true);
    const params = isRecord(rendered) ? rendered : {};

    expect(params.owner).toBe(REPO_OWNER);
    expect(params.repo).toBe(REPO_NAME);
    expect(params.pullNumber).toBe(PR_NUMBER);
    expect(params.event).toBe("REQUEST_CHANGES");
    // Pinned to the SHA the diff was read at, not to whatever is at the
    // head when the call lands.
    expect(params.commitId).toBe(HEAD_SHA);
    // A single-expression field keeps the value's type, so the findings
    // arrive as an array of objects rather than as their JSON text.
    expect(params.comments).toEqual([
      {
        path: "src/settings.ts",
        line: 11,
        body: "**Blocker** — the cache key omits the tenant id, so one tenant reads another's settings. Add the tenant id to the key.",
      },
    ]);
    const body = typeof params.body === "string" ? params.body : "";
    expect(body).toContain("One cache key is built from mutable state.");
    // The coverage line is built from the inspect step's own counters, so
    // it cannot claim a file the run never fetched.
    expect(body).toContain("fetched 3 of 3 changed files");
    expect(body).toContain("never approves");
    expect(body).not.toContain("{{");
  });

  it("does not claim it read a file the byte budget left out", () => {
    // The failure this guards: `matched_file_count` counts files whose
    // METADATA was fetched. `attachPatches` marks a file it could not
    // afford `patch_omitted` and leaves it in the array, so the count is
    // unchanged when the budget covered a fraction of the pull request.
    // A body that said "read 60 of 60" there would report full coverage on
    // a review that saw ten files.
    const partial = inspectResult();
    partial.changed_files = 60;
    partial.matched_file_count = 60;
    partial.patch_summary = {
      limit_bytes: 120000,
      included_bytes: 119873,
      truncated_files: 3,
      omitted_files: 47,
    };
    const withPartial = fullContext(eventTrigger(webhookBody("synchronize")), "REQUEST_CHANGES", {
      inspect: { result: partial },
    });
    const rendered = renderJsonTemplates(toolNode(definition, "post_review").params, withPartial);
    const params = isRecord(rendered) ? rendered : {};
    const body = typeof params.body === "string" ? params.body : "";

    // It reports fetching, never reading, and both shortfalls are named.
    expect(body).toContain("fetched 60 of 60 changed files");
    expect(body).not.toContain("read 60 of 60");
    expect(body).toContain("cut short in 3");
    expect(body).toContain("not read at all in 47");
    expect(body).toContain("was not reviewed");
  });

  it("states no filename it cannot measure", () => {
    // The names of the unread files live in `files[*].patch_truncated`, and
    // dag/v1 has no map or filter to derive them. The earlier design asked
    // the model for the list, which put a guess beside a measurement: a
    // model that wrote "none" while three files went unread contradicted
    // the counts two lines above it. No node may reintroduce that field.
    for (const node of reviewNodes()) {
      expect(JSON.stringify(node.params)).not.toContain("unreadFiles");
    }
    const review = definition.nodes.find((node): node is LlmNode => node.type === "llm");
    expect(JSON.stringify(review?.outputSchema)).not.toContain("unreadFiles");
    expect(review?.prompt).not.toContain("unreadFiles");
  });

  it("renders the fallback review with the findings in the body", () => {
    const ctx = fullContext(eventTrigger(webhookBody("opened")), "COMMENT");
    const rendered = renderJsonTemplates(toolNode(definition, "post_review_body_only").params, ctx);
    const params = isRecord(rendered) ? rendered : {};

    expect(params.event).toBe("COMMENT");
    expect(params.comments).toBeUndefined();
    const body = typeof params.body === "string" ? params.body : "";
    expect(body).toContain("`src/settings.ts:11`");
    expect(body).toContain("could not be posted");
    expect(body).not.toContain("{{");
  });

  it("names no cause it cannot know for the failure it is reporting", () => {
    // This node runs whenever `post_review` returned no review id. A bad
    // line anchor is the likeliest reason, not the only one: a 403, a
    // secondary rate limit, an action timeout, an archived repository and
    // an over-long body all land here too. The run cannot read its own
    // error — the validator rejects `nodes.<id>.error` — so a body that
    // asserted the cause would publish a confident wrong explanation of
    // its own failure, under the organization's GitHub App identity, on a
    // pull request anyone can read.
    const body = toolNode(definition, "post_review_body_only").params.body;
    const text = typeof body === "string" ? body : "";
    expect(text).not.toContain("GitHub rejected");
    expect(text).not.toContain("because one of them");
    // Stating the likely reason as likely is fine; asserting it is not.
    expect(text).toContain("usual reason");
  });

  it("names the file count in the note it posts on an oversized pull request", () => {
    const ctx = fullContext(eventTrigger(webhookBody("opened")));
    const rendered = renderJsonTemplates(toolNode(definition, "report_too_large").params, ctx);
    const params = isRecord(rendered) ? rendered : {};
    const body = typeof params.body === "string" ? params.body : "";
    expect(body).toContain("changes 3 files");
    expect(body).toContain("Split the pull request");
    expect(params.updateExisting).toBe(true);
    expect(params.comments).toBeUndefined();
  });
});

// ─── The gates ───────────────────────────────────────────────────────────

describe(`${REVIEW_ID} — gates`, () => {
  const definition = definitionOf(REVIEW_ID);

  function ifNode(id: string): IfNode {
    const node = definition.nodes.find((n): n is IfNode => n.type === "if" && n.id === id);
    if (!node) throw new Error(`no if node "${id}"`);
    return node;
  }

  it("skips a draft, a closed pull request, and one an application opened", () => {
    const conditions = ifNode("worth_reviewing").conditions;
    expect(conditions.map((c) => c.left)).toEqual([
      "trigger.data.payload.pull_request.state",
      "trigger.data.payload.pull_request.draft",
      "trigger.data.payload.pull_request.user.login",
    ]);
    // A subscription filter cannot express the bot guard: the matcher has
    // eq, in, prefix and contains, and no negation.
    const botGuard = conditions.find((c) => c.left.endsWith("user.login"));
    expect(botGuard?.operation).toBe("doesNotContain");
    expect(botGuard?.right).toBe("[bot]");
  });

  it("caps the diff before the model call, not after it", () => {
    const cap = ifNode("within_diff_cap").conditions[0];
    expect(cap?.left).toBe("nodes.inspect.result.changed_files");
    expect(cap?.operation).toBe("lessThanOrEqual");
    expect(typeof cap?.right).toBe("number");
    // The false branch posts a note. A branch that just ended the run would
    // leave the author waiting for a review that never comes.
    const branches = definition.edges.filter((edge) => edge.from === "within_diff_cap");
    expect(branches.map((edge) => edge.fromOutput).sort()).toEqual(["false", "true"]);
    expect(branches.find((edge) => edge.fromOutput === "false")?.to).toBe("report_too_large");
  });

  it("compares the two head commits inside one expression", () => {
    // An `if` condition's `right` is a literal and is never rendered, so a
    // template there would be compared as its own text.
    const gate = ifNode("head_unchanged").conditions[0];
    expect(gate?.left).toBe(
      "nodes.recheck_head.result.head.sha == trigger.data.payload.pull_request.head.sha",
    );
    expect(gate?.right).toBeUndefined();
  });

  it("posts nothing when a newer commit landed during the review", () => {
    const gate = ifNode("head_unchanged");
    const branches = definition.edges.filter((edge) => edge.from === gate.id);
    expect(branches.find((edge) => edge.fromOutput === "false")?.to).toBe("superseded");
    expect(branches.find((edge) => edge.fromOutput === "true")?.to).toBe("post_review");

    const ctx = fullContext(eventTrigger(webhookBody("synchronize")));
    const stale: TemplateContext = {
      ...ctx,
      trigger: eventTrigger(
        webhookBody("synchronize", { head: { ref: "cache-settings", sha: "0000000000000000000000000000000000000000" } }),
      ),
    };
    // Rendering the comparison is how the gate is proved to see a
    // difference at all — the executor evaluates the same expression.
    expect(renderJsonTemplates(`{{ ${gate.conditions[0]?.left} }}`, ctx)).toBe(true);
    expect(renderJsonTemplates(`{{ ${gate.conditions[0]?.left} }}`, stale)).toBe(false);
  });

  it("falls back to the body only when GitHub rejected the inline comments", () => {
    const gate = definition.nodes.find((n): n is IfNode => n.type === "if" && n.id === "inline_comments_accepted");
    expect(gate?.conditions[0]?.left).toBe("nodes.post_review.result.review_id");
    expect(gate?.conditions[0]?.operation).toBe("exists");
    // The gate is only reachable because the posting node tolerates its own
    // failure. Without this the run would end failed and post nothing.
    expect(toolNode(definition, "post_review").onError).toBe("continue");

    const branches = definition.edges.filter((edge) => edge.from === "inline_comments_accepted");
    expect(branches.map((edge) => edge.fromOutput)).toEqual(["false"]);
    expect(branches[0]?.to).toBe("post_review_body_only");
  });

  it("ends the run when a person refuses the posting step, instead of asking again", () => {
    // `create_review` is a medium-risk action, so an org policy can gate
    // it. Under the default `onDeny: "fail"` a denial writes the same
    // `failed` checkpoint a 422 writes, and `onError: "continue"` tolerates
    // both — so the fallback would post the same findings by another
    // route, which answers a refusal by asking again. `onDeny: "skip"`
    // completes the node with `policyDenied`, which this gate reads.
    const post = toolNode(definition, "post_review");
    expect(post.onDeny).toBe("skip");

    const gate = ifNode("posting_denied");
    expect(gate.conditions[0]?.left).toBe("nodes.post_review.result.policyDenied");
    expect(gate.conditions[0]?.operation).toBe("exists");

    // A denial stops. Only the non-denied branch may reach the fallback.
    const branches = definition.edges.filter((edge) => edge.from === "posting_denied");
    expect(branches.find((edge) => edge.fromOutput === "true")?.to).toBe("review_not_posted");
    expect(branches.find((edge) => edge.fromOutput === "false")?.to).toBe("inline_comments_accepted");
    // Nothing may route from the posting step straight to the fallback.
    expect(definition.edges.filter((e) => e.from === "post_review").map((e) => e.to)).toEqual([
      "posting_denied",
    ]);

    const stop = nodeOf(definition, "review_not_posted");
    expect(isRecord(stop) && stop.type).toBe("stop");
    expect(isRecord(stop) && stop.outcome).toBe("failure");
    const message = isRecord(stop) && typeof stop.message === "string" ? stop.message : "";
    // A user-facing message names what to do about it.
    expect(message).toContain("approve the step");
    expect(message).toContain("pre-approve github.create_review");
  });

  it("evaluates the denial gate correctly for both outcomes", () => {
    const gate = ifNode("posting_denied");
    const path = gate.conditions[0]?.left ?? "";
    const ctx = fullContext(eventTrigger(webhookBody("synchronize")));

    // A successful post carries a review id and no `policyDenied`.
    expect(renderJsonTemplates(`{{ exists(${path}) }}`, ctx)).toBe(false);

    // A denied gate completes the node with the shape `onDeny: "skip"`
    // writes (`workflow/src/nodes/tool.ts`).
    const denied = fullContext(eventTrigger(webhookBody("synchronize")), "REQUEST_CHANGES", {
      post_review: { result: { approved: false, policyDenied: true, resolvedBy: "a-reviewer" } },
    });
    expect(renderJsonTemplates(`{{ exists(${path}) }}`, denied)).toBe(true);
    // The fallback gate must not fire on a denial: it is downstream of the
    // false branch, and the denied result carries no review id either.
    const accepted = ifNode("inline_comments_accepted").conditions[0]?.left ?? "";
    expect(renderJsonTemplates(`{{ exists(${accepted}) }}`, denied)).toBe(false);
  });
});

// ─── The findings cap ────────────────────────────────────────────────────

describe(`${REVIEW_ID} — findings cap`, () => {
  const definition = definitionOf(REVIEW_ID);

  function reviewSchema(): Record<string, unknown> {
    const review = definition.nodes.find((node): node is LlmNode => node.type === "llm");
    const schema = review?.outputSchema;
    if (schema === undefined) throw new Error("the review node has no outputSchema");
    return schema;
  }

  function reply(findingCount: number): string {
    const findings = Array.from({ length: findingCount }, (_unused, i) => ({
      path: "src/settings.ts",
      line: i + 1,
      body: "**Minor** — rename this.",
    }));
    return `\`\`\`json\n${JSON.stringify({
      verdict: "COMMENT",
      summary: "A summary.",
      findings,
      findingsMarkdown: "- **Minor** `src/settings.ts:1` — rename this.",
    })}\n\`\`\``;
  }

  it("enforces the cap in the schema, not only in the prompt text", () => {
    // `github.create_review` takes an unbounded comment array and forwards
    // every element, so the prompt alone cannot keep the promise the
    // caveats make. These run the same validator the llm node runs.
    expect(extractStructuredOutput(reply(20), reviewSchema()).error).toBeUndefined();

    const overLong = extractStructuredOutput(reply(21), reviewSchema());
    expect(overLong.output).toBeUndefined();
    expect(overLong.error).toBeDefined();

    // The number the caveats state and the number the prompt asks for are
    // the same number.
    const properties = reviewSchema().properties;
    const findings = isRecord(properties) ? properties.findings : undefined;
    expect(isRecord(findings) ? findings.maxItems : undefined).toBe(20);
    const review = definition.nodes.find((node): node is LlmNode => node.type === "llm");
    expect(review?.prompt).toContain("at most 20 findings");
  });
});

// ─── The assign-reviewers template ───────────────────────────────────────

/**
 * The coverage rule is the whole point of this template, so it is pinned
 * here rather than left to the api suite.
 *
 * The rule itself runs in a model: dag/v1 has no map, no filter and no
 * arithmetic, so nothing else could match a path against CODEOWNERS or
 * intersect a group list. What the DEFINITION owns is the gate that stands
 * between the choice and the write, and that gate is deterministic. It
 * refuses three things: a selection whose covered count is under the count
 * of owners the paths need, an empty selection, and a selection holding
 * more people than there are owners to cover. The last one is what stops a
 * name nobody asked for from riding along beside a real cover.
 *
 * The conditions are evaluated here through `parseExpression` +
 * `evaluateExpression` — the exact pair `nodes/if.ts` calls — so a gate that
 * passes here passes for the same reason at run time.
 */
const ASSIGN_ID = "github.assign-reviewers";

/** The two operations the coverage gate uses, evaluated the way the `if`
 * executor evaluates them: the same `evaluateExpression(parseExpression(
 * cond.left), ctx)` call, then the same operation. `isIfOperationSupported`
 * is asserted beside each use, so a dataType/operation pair the executor
 * would reject fails here as well. */
function evaluateAssignCondition(condition: IfCondition, ctx: TemplateContext): boolean {
  const left = evaluateExpression(parseExpression(condition.left), ctx);
  if (condition.dataType === "boolean" && condition.operation === "isTrue") return left === true;
  if (condition.dataType === "string" && condition.operation === "exists") {
    return left !== undefined && left !== null;
  }
  if (condition.dataType === "array" && condition.operation === "lengthGreaterThan") {
    const floor = typeof condition.right === "number" ? condition.right : 0;
    return Array.isArray(left) && left.length > floor;
  }
  throw new Error(`this test evaluates no ${condition.dataType}/${condition.operation} condition`);
}

/** A context in which the shortlist and selection steps have completed.
 * `requiredOwnerCount` comes from the first model call and `coveredOwnerCount`
 * from the second, which is what the gate compares. */
function coverageContext(
  requiredOwners: string[],
  coveredOwners: string[],
  assignees: string[],
): TemplateContext {
  // Every count is derived from the list beside it, so a test states the
  // lists and the fixture cannot disagree with itself.
  return {
    trigger: {
      type: "manual",
      timestamp: "2026-08-17T09:30:01.000Z",
      data: { repositoryOwner: REPO_OWNER, repositoryName: REPO_NAME, pullNumber: PR_NUMBER },
      metadata: {},
    },
    nodes: {
      shortlist: {
        result: {
          text: "",
          output: { requiredOwners, requiredOwnerCount: requiredOwners.length, unmatchedPaths: [] },
          usage: {},
        },
      },
      select: {
        result: {
          text: "",
          output: {
            assignees,
            assigneeCount: assignees.length,
            coveredOwners,
            coveredOwnerCount: coveredOwners.length,
          },
          usage: {},
        },
      },
    },
  };
}

function assignIfNode(id: string): IfNode {
  const definition = definitionOf(ASSIGN_ID);
  const node = definition.nodes.find((n): n is IfNode => n.type === "if" && n.id === id);
  if (!node) throw new Error(`no if node "${id}"`);
  return node;
}

function coverageGatePasses(ctx: TemplateContext): boolean {
  const gate = assignIfNode("coverage_met");
  // The gate's combinator is `and` by default, which the test above pins.
  return gate.conditions.every((condition) => evaluateAssignCondition(condition, ctx));
}

const GROUP_ONE = "@example-org/group-one";
const GROUP_TWO = "@example-org/group-two";

describe(ASSIGN_ID, () => {
  const definition = definitionOf(ASSIGN_ID);
  const template = templateById(ASSIGN_ID);

  it("carries a dag/v1 definition", () => {
    expect(definition.version).toBe("dag/v1");
    expect(definition.nodes.length).toBeGreaterThan(0);
    expect(definition.edges.length).toBeGreaterThan(0);
  });

  it("arms no schedule, because it assigns one pull request the person names", () => {
    expect(template.schedule).toBeUndefined();
    const trigger = definition.nodes.find((node) => node.type === "trigger");
    const schema = trigger?.type === "trigger" ? trigger.dataSchema : undefined;
    expect(Object.keys(schema ?? {})).toEqual([
      "repositoryOwner",
      "repositoryName",
      "pullNumber",
      "codeownersPath",
      "rosterOwner",
      "rosterRepository",
      "rosterPath",
      "excludeHandles",
    ]);
  });

  it("declares no default on the two fields that belong to one run", () => {
    // Install BAKES every value it is given and drops the field from the
    // schema, and the install dialog pre-fills every DECLARED DEFAULT. So a
    // default on a per-run field freezes that field at install: the pull
    // request number would pin every later run to one pull request, and the
    // exclude field — the documented way to run again after somebody
    // declines — would disappear from the run form entirely.
    const trigger = definition.nodes.find((node) => node.type === "trigger");
    const schema = trigger?.type === "trigger" ? trigger.dataSchema : undefined;
    expect(schema?.pullNumber?.default).toBeUndefined();
    expect(schema?.excludeHandles?.default).toBeUndefined();
    // And the install-time fields keep theirs, because those are meant to
    // be answered once.
    expect(schema?.codeownersPath?.default).toBe(".github/CODEOWNERS");
    expect(schema?.rosterPath?.default).toBe(".github/reviewer-roster.csv");
  });

  it("tells the reader, on both per-run fields, to leave them empty at install", () => {
    const trigger = definition.nodes.find((node) => node.type === "trigger");
    const schema = trigger?.type === "trigger" ? trigger.dataSchema : undefined;
    expect(schema?.pullNumber?.description).toContain("Leave this empty when you install");
    expect(schema?.pullNumber?.description).toContain("run form");
    expect(schema?.excludeHandles?.description).toContain("Leave this empty when you install");
    expect(schema?.excludeHandles?.description).toContain("run form");
  });

  it("takes the roster as an input, because no action lists a team's members", () => {
    // The decisive capability gap. This plugin calls no endpoint under
    // /orgs/{org}/teams/{slug}/members, so `@example-org/group-one` is an
    // opaque string here and membership has to be supplied.
    const teamCalls = githubPlugin.actions.filter((a) => JSON.stringify(a).includes("/teams/"));
    expect(teamCalls.map((a) => a.id)).toEqual([]);

    const trigger = definition.nodes.find((node) => node.type === "trigger");
    const schema = trigger?.type === "trigger" ? trigger.dataSchema : undefined;
    expect(schema?.rosterPath?.required).toBe(true);
    expect(schema?.rosterPath?.description).toContain("groups");
  });
});

describe(`${ASSIGN_ID} — the coverage rule`, () => {
  it("declares a gate the if executor can run", () => {
    const gate = assignIfNode("coverage_met");
    expect(gate.combinator).toBeUndefined(); // `and`
    for (const condition of gate.conditions) {
      expect(isIfOperationSupported(condition.dataType, condition.operation)).toBe(true);
    }
    // The comparison is between two model calls, not inside one: the count
    // of owners the paths need against the count the choice covers.
    expect(gate.conditions[0]?.left).toBe(
      "nodes.shortlist.result.output.requiredOwnerCount == nodes.select.result.output.coveredOwnerCount",
    );
    expect(gate.conditions[0]?.right).toBeUndefined();
    expect(gate.conditions[2]?.left).toBe(
      "nodes.select.result.output.assigneeCount <= nodes.shortlist.result.output.requiredOwnerCount",
    );
  });

  it("never shows the selection step the count the gate compares against", () => {
    // A step handed the target number reports the target number back, and
    // the cross-check would then be reading its own answer.
    const select = definitionOf(ASSIGN_ID).nodes.find(
      (n): n is LlmNode => n.type === "llm" && n.id === "select",
    );
    expect(select?.prompt).toContain("{{ nodes.shortlist.result.output.requiredOwners }}");
    expect(select?.prompt).not.toContain("requiredOwnerCount");
  });

  it("counts its own assignees, so the gate has a number to compare", () => {
    const select = definitionOf(ASSIGN_ID).nodes.find(
      (n): n is LlmNode => n.type === "llm" && n.id === "select",
    );
    expect(select?.prompt).toContain("assigneeCount is how many entries assignees holds");
    const schema = select?.outputSchema;
    const properties = isRecord(schema) && isRecord(schema.properties) ? schema.properties : {};
    expect(isRecord(properties.assigneeCount) && properties.assigneeCount.type).toBe("number");
    const required = isRecord(schema) && Array.isArray(schema.required) ? schema.required : [];
    expect(required).toContain("assigneeCount");
  });

  it("passes one person who belongs to both groups", () => {
    const ctx = coverageContext([GROUP_ONE, GROUP_TWO], [GROUP_ONE, GROUP_TWO], ["reviewer-one"]);
    expect(coverageGatePasses(ctx)).toBe(true);
  });

  it("passes two people with one group each", () => {
    const ctx = coverageContext(
      [GROUP_ONE, GROUP_TWO],
      [GROUP_ONE, GROUP_TWO],
      ["reviewer-one", "reviewer-two"],
    );
    expect(coverageGatePasses(ctx)).toBe(true);
  });

  it("refuses a choice that covers one of two groups", () => {
    // The failure the request names: a second group was asked for and
    // nobody answers for it. Assigning the first group's reviewer here
    // would read as a finished assignment.
    const ctx = coverageContext([GROUP_ONE, GROUP_TWO], [GROUP_ONE], ["reviewer-one"]);
    expect(coverageGatePasses(ctx)).toBe(false);
  });

  it("refuses a rider: a real cover plus one name nobody needed", () => {
    // Both owners covered, so the count comparison passes and the list is
    // not empty. The third name is the failure: a minimal cover of two
    // owners never needs three people, so somebody here covers nothing and
    // would be assigned, and DM'd, on a guess.
    const ctx = coverageContext(
      [GROUP_ONE, GROUP_TWO],
      [GROUP_ONE, GROUP_TWO],
      ["reviewer-one", "reviewer-two", "rider-nobody-asked-for"],
    );
    expect(evaluateAssignCondition(assignIfNode("coverage_met").conditions[0]!, ctx)).toBe(true);
    expect(evaluateAssignCondition(assignIfNode("coverage_met").conditions[1]!, ctx)).toBe(true);
    expect(coverageGatePasses(ctx)).toBe(false);
  });

  it("refuses a rider beside a single-owner cover", () => {
    const ctx = coverageContext([GROUP_ONE], [GROUP_ONE], ["reviewer-one", "rider-nobody-asked-for"]);
    expect(coverageGatePasses(ctx)).toBe(false);
  });

  it("passes three people for three owners, the cap the template states", () => {
    const ctx = coverageContext(
      [GROUP_ONE, GROUP_TWO, "@example-org/group-three"],
      [GROUP_ONE, GROUP_TWO, "@example-org/group-three"],
      ["reviewer-one", "reviewer-two", "reviewer-three"],
    );
    expect(coverageGatePasses(ctx)).toBe(true);
  });

  it("refuses to assign when no owner rule matched the changed paths", () => {
    // Both counts are zero, so the comparison is true. The second condition
    // is what stops it: with no owner named, every name is a guess.
    const ctx = coverageContext([], [], []);
    expect(evaluateAssignCondition(assignIfNode("coverage_met").conditions[0]!, ctx)).toBe(true);
    expect(coverageGatePasses(ctx)).toBe(false);
  });

  it("states both ways of satisfying two groups in the prompt that has to do it", () => {
    const definition = definitionOf(ASSIGN_ID);
    const select = definition.nodes.find((n): n is LlmNode => n.type === "llm" && n.id === "select");
    const prompt = select?.prompt ?? "";
    expect(prompt).toContain("one person who covers both is the answer");
    expect(prompt).toContain("take one person for each");
    expect(prompt).toContain("assignees is empty");
    // The cap the schema enforces and the cap the prompt asks for are the
    // same number.
    const schema = select?.outputSchema;
    const properties = isRecord(schema) && isRecord(schema.properties) ? schema.properties : {};
    const assignees = properties.assignees;
    const cap = isRecord(assignees) && typeof assignees.maxItems === "number" ? assignees.maxItems : 0;
    expect(cap).toBeGreaterThan(0);
    expect(prompt).toContain(`Assign at most ${cap} people`);
  });
});

describe(`${ASSIGN_ID} — what it writes and who it tells`, () => {
  const definition = definitionOf(ASSIGN_ID);

  it("writes the assignees field, and never a reviewer request", () => {
    const assign = toolNode(definition, "assign");
    expect(assign.action).toBe("update_pull_request");
    expect(assign.params.assignees).toBe("{{ nodes.select.result.output.assignees }}");
    // `requested_reviewers` is a different field with a different meaning,
    // and no action here writes it.
    expect(JSON.stringify(definition)).not.toContain("requested_reviewers");
  });

  it("renders the assignee list as an array, not as its JSON text", () => {
    const ctx = coverageContext([GROUP_ONE], [GROUP_ONE], ["reviewer-one", "reviewer-two"]);
    const rendered = renderJsonTemplates(toolNode(definition, "assign").params, ctx);
    const params = isRecord(rendered) ? rendered : {};
    expect(params.assignees).toEqual(["reviewer-one", "reviewer-two"]);
    expect(params.pullNumber).toBe(PR_NUMBER);
  });

  it("reaches the write only through the coverage gate", () => {
    const intoAssign = definition.edges.filter((edge) => edge.to === "assign");
    expect(intoAssign.map((edge) => `${edge.from}:${edge.fromOutput ?? "-"}`)).toEqual(["coverage_met:true"]);

    const miss = definition.edges.filter((edge) => edge.from === "coverage_met" && edge.fromOutput === "false");
    expect(miss.map((edge) => edge.to)).toEqual(["report_gap"]);
    // The miss is reported and the run ends failed. It never falls through
    // to a partial assignment.
    expect(definition.edges.filter((e) => e.from === "report_gap").map((e) => e.to)).toEqual([
      "assignment_failed",
    ]);
  });

  it("tells the person who started the run why nobody was assigned", () => {
    const gap = toolNode(definition, "report_gap");
    expect(gap.service).toBe("slack");
    // `dm_owner` needs no Slack id, so the reason reaches the requester
    // without another identity mapping.
    expect(gap.action).toBe("dm_owner");
    expect(JSON.stringify(gap.params)).toContain("nodes.select.result.output.failureReason");
    // A Slack that cannot deliver must not swallow the reason. `dm_owner`
    // fails outright when the owner has not linked a Slack identity, and
    // `continue` hides that, so the stop node below carries the SAME
    // failureReason rather than a generic instruction. Nothing else reports
    // on this branch.
    expect(gap.onError).toBe("continue");

    const stop = nodeOf(definition, "assignment_failed");
    const message = isRecord(stop) && typeof stop.message === "string" ? stop.message : "";
    expect(isRecord(stop) && stop.outcome).toBe("failure");
    expect(message).toContain("{{ nodes.select.result.output.failureReason }}");
    expect(message).toContain("start the workflow again");
    // It must never claim a delivery it could not make.
    expect(message).not.toContain("sent to you on Slack");
  });

  it("renders the reason into the failure message, not the path text", () => {
    // `stop` renders `message` through `renderTemplate`, so the reason a
    // failed DM could not deliver still reaches the run's own outcome.
    const ctx = coverageContext([GROUP_ONE, GROUP_TWO], [GROUP_ONE], []);
    const nodes = isRecord(ctx.nodes) ? ctx.nodes : {};
    const select = isRecord(nodes.select) && isRecord(nodes.select.result) ? nodes.select.result : {};
    const output = isRecord(select.output) ? { ...select.output } : {};
    output.failureReason = `Nobody in the roster answers for ${GROUP_TWO}.`;
    const withReason: TemplateContext = {
      ...ctx,
      nodes: { ...nodes, select: { result: { text: "", output, usage: {} } } },
    };

    const stop = nodeOf(definition, "assignment_failed");
    const message = isRecord(stop) && typeof stop.message === "string" ? stop.message : "";
    const rendered = renderTemplate(message, withReason);
    expect(String(rendered)).toContain(`Nobody in the roster answers for ${GROUP_TWO}.`);
  });

  it("reads the pull request back, because the write cannot report itself", () => {
    // `github.update_pull_request` returns number, url, title and state.
    // GitHub drops an assignee change from an account without push access
    // and still answers 200, so nothing in that response can catch it.
    const update = githubPlugin.actions.find((a) => a.id === "github.update_pull_request");
    expect(update).toBeDefined();

    const verify = toolNode(definition, "verify");
    expect(verify.action).toBe("inspect_pull_request");
    expect(definition.edges.filter((e) => e.from === "assign").map((e) => e.to)).toEqual(["verify"]);
    expect(JSON.stringify(definitionOf(ASSIGN_ID))).toContain("nodes.verify.result.assignees");
  });

  it("messages only the people the read-back confirmed", () => {
    const notify = definition.nodes.find((n) => n.type === "foreach" && n.id === "notify");
    expect(notify?.type).toBe("foreach");
    // Not `nodes.select.result.output.assignees`: a name GitHub dropped
    // must not receive a message saying it was assigned.
    expect(notify?.type === "foreach" ? notify.items : "").toBe("{{ nodes.confirm.result.output.landed }}");
    expect(notify?.type === "foreach" ? notify.body.id : "").toBe("send_dm");
  });

  it("tells the confirm step to copy the Slack id it is about to address", () => {
    // `send_dm` addresses `{{ item.slackUserId }}`, and that item comes from
    // `confirm`, not from the roster read. So a model re-writes the delivery
    // address, and its schema REQUIRES the field — it will emit something
    // whatever it was told. Without an instruction to copy the id from the
    // selection entry with the same handle, a transposed or invented id
    // delivers one person's review assignment to an unrelated Slack account.
    // The handle rule alone never covered this: it constrains handles.
    const dm = definition.nodes.find((n) => n.type === "foreach" && n.id === "notify");
    const body = dm?.type === "foreach" ? dm.body : undefined;
    const params = body && "params" in body ? body.params : undefined;
    expect(isRecord(params) ? params.user : "").toBe("{{ item.slackUserId }}");

    const confirm = definition.nodes.find(
      (n): n is LlmNode => n.type === "llm" && n.id === "confirm",
    );
    expect(confirm?.prompt ?? "").toContain(
      "Take each landed person's slackUserId from the selection entry that carries the same handle",
    );
    expect(confirm?.prompt ?? "").toContain("Never write an id you did not read in that list");
    expect(confirm?.system ?? "").toContain(
      "You never write a Slack user id that is not in the data you were given",
    );
  });

  it("ends the run failed when GitHub kept a chosen name off", () => {
    const gate = assignIfNode("everyone_landed");
    expect(gate.conditions[0]?.left).toBe("nodes.confirm.result.output.dropped");
    expect(gate.conditions[0]?.operation).toBe("isEmpty");
    // After the report, so the report is delivered either way.
    expect(definition.edges.filter((e) => e.to === "everyone_landed").map((e) => e.from)).toEqual(["report"]);
    const miss = definition.edges.filter((e) => e.from === "everyone_landed" && e.fromOutput === "false");
    expect(miss.map((e) => e.to)).toEqual(["assignment_dropped"]);
  });

  it("leaves a pull request that somebody already owns alone", () => {
    // `update_pull_request` REPLACES the assignee list, so a run that ignored this
    // would take the pull request away from whoever holds it.
    const gate = assignIfNode("assignable");
    expect(gate.conditions.map((c) => `${c.left}:${c.operation}`)).toEqual([
      "nodes.pull_request.result.state:equals",
      "nodes.pull_request.result.draft:isFalse",
      "nodes.pull_request.result.assignees:isEmpty",
    ]);
    const stop = nodeOf(definition, "not_assignable");
    const message = isRecord(stop) && typeof stop.message === "string" ? stop.message : "";
    expect(message).toContain("was read, and it was not assigned");
    expect(message).toContain("clear the assignees field");
  });

  it("says the pull request could not be read, instead of guessing why", () => {
    // A failed `pull_request` node contributes nothing to the context, so
    // every condition in `assignable` would miss and answer false. The run
    // would then name three causes that are all wrong, and ask for a fix
    // nobody can apply. This gate stands in front of it.
    const gate = assignIfNode("pull_request_read");
    expect(gate.conditions.map((c) => `${c.left}:${c.dataType}:${c.operation}`)).toEqual([
      "nodes.pull_request.result.state:string:exists",
    ]);
    for (const condition of gate.conditions) {
      expect(isIfOperationSupported(condition.dataType, condition.operation)).toBe(true);
    }
    // With the pull request missing from the context — which is what a
    // failed node leaves behind — the gate is false and the run takes the
    // branch that names the real fix.
    expect(evaluateAssignCondition(gate.conditions[0]!, { nodes: {} })).toBe(false);
    expect(
      evaluateAssignCondition(gate.conditions[0]!, {
        nodes: { pull_request: { result: { state: "open" } } },
      }),
    ).toBe(true);

    expect(definition.edges.filter((e) => e.to === "assignable").map((e) => `${e.from}:${e.fromOutput}`)).toEqual([
      "pull_request_read:true",
    ]);
    const stop = nodeOf(definition, "pull_request_unread");
    const message = isRecord(stop) && typeof stop.message === "string" ? stop.message : "";
    expect(isRecord(stop) && stop.outcome).toBe("failure");
    expect(message).toContain("could not be read");
    expect(message).toContain("Check that the number is right");
    expect(message).toContain("can read the repository");
  });

  it("names nobody real, and keeps its example groups to placeholders", () => {
    // A handle written into a definition would send every install to one
    // person. The only @ tokens here belong to the example org.
    const handles = JSON.stringify(definition).match(/@[a-z][a-z0-9/-]+/gi) ?? [];
    expect(handles.filter((handle) => !handle.startsWith("@handle") && !handle.startsWith("@org/team"))).toEqual([]);
  });
});

describe(`${ASSIGN_ID} — what it says it cannot do`, () => {
  const template = templateById(ASSIGN_ID);
  const caveatList = template.caveats ?? [];
  const caveats = caveatList.join("\n");

  /**
   * The four things the request asked for that this platform cannot do.
   * A reader stops part-way down a list of twenty-three lines, so these
   * four lead it. Matched on the opening clause of each line, which is
   * what a reader sees before they decide to keep reading.
   */
  const GAPS = [
    "It cannot read a GitHub team.",
    "It does not know anybody's working hours.",
    "It has no signal for who last worked on the changed code.",
    "It cannot swap a reviewer who declines.",
  ];

  it("leads with the four gaps against the request, before any other limit", () => {
    const opening = caveatList.slice(0, GAPS.length).map((line) => line.slice(0, line.indexOf(".") + 1));
    expect(opening).toEqual(GAPS);
  });

  it("names the roster inside the opening the card can actually show", () => {
    // The install dialog shows the whole description; the card clamps it to
    // TWO LINES. "Somewhere in the description" is therefore not enough,
    // and it was the earlier failure: the opening sentence alone ran to 151
    // characters, which fills both lines of a half-width card, so the
    // roster clause behind it was clipped at most widths. A reader who
    // reads nothing else must still learn that a file they maintain decides
    // who can be assigned.
    expect(template.description.slice(0, 120)).toContain("roster");
    expect(template.description).toContain("who is in each owner group");
    expect(template.description).toContain("timezone and working hours");
  });

  it("says in the description that a decline needs a second run", () => {
    expect(template.description).toContain("cannot wait for a reply");
  });

  it("never lets a step claim the run enforces working hours or code familiarity", () => {
    const steps = template.steps.join("\n");
    // The failure this pins: "inside their working hours where it can"
    // reads as a rule the run keeps. Working hours only rank.
    expect(steps).toContain("Working hours and the roster's areas column only break a tie");
    expect(steps).toContain("both come from the roster");
    expect(steps).not.toContain("inside their working hours");
  });

  it("says in the steps that the roster is the only source of group membership", () => {
    expect(template.steps.join("\n")).toContain("no action here reads a GitHub team");
  });

  it("ends the steps on the missing swap, so the list does not imply one", () => {
    expect(template.steps[template.steps.length - 1]).toContain("Nothing waits for a reply");
  });

  it("says the swap is not built, instead of faking it with a sleep", () => {
    // No node type parks on an inbound message: `wait` counts down a
    // duration, `approval` waits on the approvals path, and nothing in the
    // Slack plugin resolves either.
    const definition = definitionOf(ASSIGN_ID);
    expect(definition.nodes.filter((node) => node.type === "wait")).toEqual([]);
    expect(definition.nodes.filter((node) => node.type === "approval")).toEqual([]);
    expect(caveats).toContain("cannot swap a reviewer who declines");
    expect(caveats).toContain("exclude field");
  });

  it("says where team membership comes from", () => {
    expect(caveats).toContain("No action here lists the members of @your-org/group-one");
  });

  it("says the time-off check can fail, and what an unchecked person means", () => {
    expect(caveats).toContain("shared with you at reader level");
    expect(caveats).toContain("their time was not checked");
  });

  it("describes the same time-off window the selection step applies", () => {
    // The copy and the graph have to name one window. A caveat that
    // promises more than the prompt asks for is the failure this pins:
    // "not on PTO" has to mean the days the review is read in, not the
    // instant the run starts.
    const select = definitionOf(ASSIGN_ID).nodes.find(
      (n): n is LlmNode => n.type === "llm" && n.id === "select",
    );
    const prompt = select?.prompt ?? "";
    const window = prompt.match(/covers any part of the (\d+) days after the time now/);
    expect(window).not.toBeNull();
    const days = window?.[1] ?? "";
    expect(caveats).toContain(`covers any part of the next ${days} days`);
    // And the horizon that the window sits inside is stated as well.
    expect(caveats).toContain("next 10 events");
    expect(prompt).toContain("does not exclude anybody");
  });

  it("states the gate's real limit, and does not sell it as a no-rider rule", () => {
    // The third condition is `assigneeCount <= requiredOwnerCount`. It sees
    // a surplus name only ABOVE the owner count: three required owners, one
    // roster row covering all three, and a choice of that person plus two
    // people nobody needed still reports three names for three owners and
    // passes. The caveat used to promise it refused "a person no owner
    // needed", with no qualifier, in the one caveat whose job is to
    // separate what a model decides from what the definition enforces.
    const gate = assignIfNode("coverage_met");
    expect(gate.conditions[2]?.left).toBe(
      "nodes.select.result.output.assigneeCount <= nodes.shortlist.result.output.requiredOwnerCount",
    );
    expect(caveats).toContain("names more people than the changed paths have owners");
    expect(caveats).toContain("it cannot see a name nobody needed");
    expect(caveats).not.toContain("carries a person no owner needed");
  });

  it("describes the gallery it is really shown in", () => {
    // `listWorkflowTemplateSummaries` excludes a template only when its
    // definition fails validation. Connection state is reported per
    // requirement and never filters the list, so the card IS offered and
    // only the Install control is withheld. The earlier wording promised a
    // filter that does not exist, and contradicted the Slack caveat beside
    // it, which describes the same situation correctly.
    expect(caveats).not.toContain("The gallery does not offer a template whose services");
    expect(caveats).toContain("The gallery still shows the card");
    expect(caveats).toContain("withholds the install until the connection exists");
  });

  it("says the pull request and the exclude list are collected on each run", () => {
    // The claim has to match what install leaves behind. Both fields
    // declare no default, so a reader who leaves them empty keeps them on
    // the run form — which is what makes the decline mitigation reachable
    // at all.
    expect(caveats).toContain("Leave the pull request number and the exclude field empty when you install");
    expect(caveats).toContain("the run form asks for both every time you start it");
    expect(caveats).toContain("A value you type at install is written into the workflow instead");
  });

  it("says a model decides the coverage the gate then counts", () => {
    // The one claim that decides who is assigned. Every other soft signal
    // in this list is flagged as model work, and this was not.
    expect(caveats).toContain("a model makes both of them");
    expect(caveats).toContain("Nothing in a workflow can read a GitHub group");
    expect(caveats).toContain("compares counts");
  });

  it("caps people, and says it caps people", () => {
    expect(caveats).toContain("The cap counts people and not owners");
    expect(caveats).not.toContain("owners covered is reported as uncovered");
  });

  it("says the organization has to set Slack up before anybody can connect it", () => {
    // #305 hides an unconfigured service from the integrations page, so a
    // reader who is told only "connect Slack" finds no Slack to connect.
    expect(caveats).toContain("an admin does in Settings, then Organization");
    expect(caveats).toContain("this template cannot be installed");
  });

  it("says Google Calendar has to be connected before the install", () => {
    expect(caveats).toContain("must be connected on your own account before you can install this");
    // Signing in with Google is a different token with different scopes.
    expect(caveats).toContain("sign-in scopes only");
  });

  it("says it has no signal for who last worked on the code", () => {
    expect(caveats).toContain("no signal for who last worked on the changed code");
  });

  it("says GitHub can drop the assignment without failing", () => {
    expect(caveats).toContain("drops it, with no error");
  });
});
