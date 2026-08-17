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
  renderJsonTemplates,
  validateWorkflowDefinition,
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
