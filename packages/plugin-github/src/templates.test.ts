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
  type ForeachNode,
  type LlmNode,
  type OrchestratorNode,
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

function orchestratorNode(definition: WorkflowDefinition, id: string): OrchestratorNode {
  const node = definition.nodes.find(
    (n): n is OrchestratorNode => n.type === "orchestrator" && n.id === id,
  );
  if (!node) throw new Error(`no orchestrator node "${id}"`);
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

/** The triage llm node's structured output — the unchanged files the review
 * asked to have fetched. */
function triageOutput(): Record<string, unknown> {
  return { paths: ["AGENTS.md", "src/cache-key.ts", "src/missing.ts"] };
}

/** The read_context foreach aggregate, in the shape `ForeachResult` defines.
 * One item completed, one came back cut short at the byte budget, and one was
 * skipped — the three outcomes the review prompt tells the model apart, so a
 * fixture with only successes would leave the wording for the other two
 * unexercised. */
function contextFilesResult(): Record<string, unknown> {
  return {
    items: [
      {
        status: "completed",
        data: {
          path: "AGENTS.md",
          repo: `${REPO_OWNER}/${REPO_NAME}`,
          ref: HEAD_SHA,
          size: 812,
          content: "# Agent instructions\n\nRun `pnpm test` before opening a pull request.\n",
          truncated: false,
        },
      },
      {
        status: "completed",
        data: {
          path: "src/cache-key.ts",
          repo: `${REPO_OWNER}/${REPO_NAME}`,
          ref: HEAD_SHA,
          size: 41000,
          content: "export function cacheKey(tenantId: string, id: string) {",
          truncated: true,
        },
      },
      { status: "skipped", error: 'Read repo file: no file at "src/missing.ts"' },
    ],
    count: 3,
    inputCount: 3,
    truncatedCount: 0,
    completedCount: 2,
    skippedCount: 1,
    failedCount: 0,
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
  const triage = { result: { text: "", output: triageOutput(), usage: {} } };
  const read_context = { result: contextFilesResult() };
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
    // The `read_context` foreach body renders against its iteration's
    // aliases, which the interpreter merges into this same context
    // (`resolveTemplateContext`, `workflow/src/nodes/index.ts`). A fixture
    // that models every node as completed has to carry them, or the body's
    // `{{ item }}` reads as a path nothing resolves — the one hole in this
    // definition that is not a hole.
    item: "AGENTS.md",
    index: 0,
    nodes: {
      inspect,
      triage,
      read_context,
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

/** Templates this package can validate on its own. The assign-reviewers
 * template also calls Google Calendar, and only `packages/api` loads every
 * plugin, so its own suite is where a cross-service definition is
 * validated. */
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

  it("calls no service this deployment cannot offer", () => {
    // `SERVICES_NOT_READY` (`api/src/workflows/templates.ts`) hides every
    // template that needs Slack, and `requires` is read off the TOOL NODES.
    // So one slack tool node anywhere in this file takes the whole card out
    // of the gallery. The api suite pins the derived `requires`; this pins
    // the node that would produce it, in the file an author edits.
    const services = githubTemplates.flatMap((template) => {
      const definition = template.definition as WorkflowDefinition;
      return definition.nodes.flatMap((node) => {
        if (node.type === "tool") return [node.service];
        if (node.type === "foreach" && node.body.type === "tool") return [node.body.service];
        return [];
      });
    });
    expect([...new Set(services)].sort()).toEqual(["github", "google_calendar", "slack"]);
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

  it("keeps the caveats to a couple of paragraphs — a reader has to actually read this", () => {
    const caveatList = template.caveats ?? [];
    expect(caveatList.length).toBeLessThanOrEqual(3);
    for (const entry of caveatList) expect(entry.length).toBeLessThan(400);
    const caveats = caveatList.join("\n");
    expect(caveats).toContain("Installing it arms its own trigger");
    expect(caveats).toContain("never approves");
    // The event keys used to live in this prose because a person had to
    // type them into the Triggers form. Install arms them now, so the
    // manifest is where they belong — and where a test can check them.
    expect(template.events?.flatMap((e) => e.eventKeys)).toContain("github.pull_request.opened");
  });

  it("collects only the repository its trigger filter needs, plus the hidden payload", () => {
    const trigger = definition.nodes.find((node) => node.type === "trigger");
    expect(trigger?.type).toBe("trigger");
    const schema = trigger?.type === "trigger" ? trigger.dataSchema : undefined;
    // `repository` is read by no node — it exists so install can arm the
    // event trigger with a repo filter. `payload` is hidden, so the run
    // dialog still asks for nothing (`visibleTriggerFields`).
    expect(Object.keys(schema ?? {})).toEqual(["repository", "payload"]);
    expect(schema?.repository?.required).toBe(true);
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
    const review = definition.nodes.find((node): node is LlmNode => node.type === "llm" && node.id === "review");
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
    const review = definition.nodes.find((node): node is LlmNode => node.type === "llm" && node.id === "review");
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
    const review = definition.nodes.find((node): node is LlmNode => node.type === "llm" && node.id === "review");
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
    const review = definition.nodes.find((node): node is LlmNode => node.type === "llm" && node.id === "review");
    expect(review?.prompt).toContain("at most 20 findings");
  });
});

describe(`${REVIEW_ID} — repository context`, () => {
  const definition = definitionOf(REVIEW_ID);

  function foreachNode(id: string): ForeachNode {
    const node = definition.nodes.find((n): n is ForeachNode => n.type === "foreach" && n.id === id);
    if (!node) throw new Error(`no foreach node "${id}"`);
    return node;
  }

  function llmNode(id: string): LlmNode {
    const node = definition.nodes.find((n): n is LlmNode => n.type === "llm" && n.id === id);
    if (!node) throw new Error(`no llm node "${id}"`);
    return node;
  }

  /** A foreach body is a union of six node types and only some carry
   * `params`, so narrowing on `type` is what reads them without a cast. */
  function bodyParams(id: string): Record<string, unknown> {
    const body = foreachNode(id).body;
    if (body.type !== "tool") throw new Error(`foreach "${id}" body is a ${body.type} node, not a tool node`);
    return body.params;
  }

  it("spends at most one diff budget on the repository, so the ceiling stays readable", () => {
    // The property the caveats and the coverage block both rest on: reading
    // unchanged files at most DOUBLES a run's input. A per-file cap raised
    // without lowering the file count silently breaks that, and this is
    // where it breaks.
    const perFile = bodyParams("read_context").maxBytes;
    const files = foreachNode("read_context").maxItems;
    expect(typeof perFile).toBe("number");
    expect(typeof files).toBe("number");
    expect(Number(perFile) * Number(files)).toBeLessThanOrEqual(120000);
    // A whole number of bytes. The action slices a byte array with it, and a
    // fraction would be a budget no read could land on exactly.
    expect(Number.isInteger(perFile)).toBe(true);
  });

  it("caps the selection in the schema, not only in the prompt text", () => {
    // Same reason the findings cap is enforced in `outputSchema`: the
    // foreach truncates at `maxItems` and REPORTS the truncation, so a
    // longer list would turn a documented ceiling into a warning on the run
    // page of every pull request.
    const schema = llmNode("triage").outputSchema;
    const properties = isRecord(schema) && isRecord(schema.properties) ? schema.properties : {};
    const paths = properties.paths;
    expect(isRecord(paths) ? paths.maxItems : undefined).toBe(foreachNode("read_context").maxItems);
  });

  it("reads the repository at the commit the diff was read at", () => {
    // Not the branch tip. A review that quotes the diff of one commit
    // against the repository as of another reviews a state that never
    // existed — and the tip moves on a busy pull request while the run is
    // still going.
    const params = bodyParams("read_context");
    expect(params.ref).toBe("{{ nodes.inspect.result.head.sha }}");
    // And the same commit the review is posted against, so the diff, the
    // files read beside it, and the lines the comments land on are all one
    // state of the repository.
    expect(toolNode(definition, "post_review").params.commitId).toBe(params.ref);
  });

  it("skips a file it cannot read instead of failing the review", () => {
    // The triage step derives paths from import lines, which is a guess, and
    // a fork's head commit may not resolve in the base repository at all.
    // Under the default policy the first 404 would take down a review that
    // the diff alone could still have produced.
    expect(foreachNode("read_context").onItemError).toBe("skip");
  });

  it("selects with a cheaper model than it reviews with", () => {
    // Selection reads import lines and names paths; reviewing is the
    // expensive half. Paying the reviewing model twice for the same diff is
    // the cost this split exists to avoid, so a change that levels them up
    // should be a deliberate one.
    expect(llmNode("triage").model).not.toBe(llmNode("review").model);
  });

  it("keeps the selector out of the reviewing seat", () => {
    // Two different jobs, and the cheap one must not start reporting. A
    // triage step that returns findings would put them beside the review's
    // own with none of its scrutiny.
    const triage = llmNode("triage");
    const schema = triage.outputSchema;
    const properties = isRecord(schema) && isRecord(schema.properties) ? schema.properties : {};
    expect(Object.keys(properties)).toEqual(["paths"]);
    expect(triage.system).toContain("report no findings");
  });

  it("tells the reviewer the fetched files are context, not a place to anchor a finding", () => {
    // `github.create_review` rejects the WHOLE review when one comment names
    // a line outside the diff, so a finding anchored into an unchanged file
    // costs every other finding on the pull request.
    const review = llmNode("review");
    expect(review.prompt).toContain("{{ nodes.read_context.result.items }}");
    expect(review.prompt).toContain("Never report a finding against a line in one of them");
    expect(review.prompt).toContain("anchors to a line this pull request added or changed");
  });

  it("no longer tells a reader it cannot open an unchanged file", () => {
    // The coverage block's old sentence was true and is now false, and a
    // review that understates what it read is as misleading as one that
    // overstates it.
    const body = String(toolNode(definition, "post_review").params.body);
    expect(body).not.toContain("does not open an unchanged file");
    expect(body).toContain("{{ nodes.read_context.result.completedCount }}");
    expect(body).toContain("{{ nodes.read_context.result.inputCount }}");
    // A cap that drops a file has to say so. Nothing else in the posted
    // review would tell a reader the run asked for less than it chose to.
    expect(body).toContain("{{ nodes.read_context.result.truncatedCount }}");
  });

  it("counts coverage off the run, never off the model", () => {
    // Both new numbers come from the foreach aggregate, which the runtime
    // measures. A count the model wrote could claim files it never opened,
    // two lines below a sentence that says what it did open.
    for (const id of ["post_review", "post_review_body_only"]) {
      const body = String(toolNode(definition, id).params.body);
      expect(body).not.toContain("nodes.triage.result");
      expect(body).not.toContain("nodes.review.result.output.filesRead");
    }
  });

  it("routes the review through the context stage, with no path around it", () => {
    // An edge left in place from `within_diff_cap` straight to `review`
    // would give some runs the context and others not, with nothing in the
    // posted review to tell a reader which kind they were reading.
    const into = (id: string) => definition.edges.filter((e) => e.to === id).map((e) => e.from);
    expect(into("triage")).toEqual(["within_diff_cap"]);
    expect(into("read_context")).toEqual(["triage"]);
    expect(into("review")).toEqual(["read_context"]);
  });
});

// ─── The assign-reviewers template ───────────────────────────────────────

/**
 * The coverage rule is the whole point of branch A, so it is pinned here
 * rather than left to the api suite.
 *
 * The rule itself runs in a model: dag/v1 has no map, no filter and no
 * arithmetic, so nothing else could match a path against CODEOWNERS or
 * intersect a group list. What the DEFINITION owns is the gate that stands
 * between the choice and the write, and that gate is deterministic.
 *
 * The conditions are evaluated here through `parseExpression` +
 * `evaluateExpression` — the exact pair `nodes/if.ts` calls — so a gate that
 * passes here passes for the same reason at run time.
 */
const ASSIGN_ID = "github.assign-reviewers";

/** The operations the coverage gates use, evaluated the way the `if`
 * executor evaluates them. `isIfOperationSupported` is asserted beside each
 * use, so a dataType/operation pair the executor would reject fails here as
 * well. */
/** `asNumber`/`asString`, copied from `packages/workflow/src/nodes/if.ts`
 * rather than imported — that file exports no per-type comparator, only the
 * whole node executor. Keeping the coercion identical to the source is the
 * point: a fixture typed differently from what these coerce must fail the
 * same way the real gate would fail on a live pull request. */
function asNumber(v: unknown): number {
  if (typeof v === "number") return v;
  if (typeof v === "string") {
    const n = Number(v);
    if (!Number.isNaN(n)) return n;
  }
  return NaN;
}

function asString(v: unknown): string {
  if (v === null || v === undefined) return "";
  if (typeof v === "string") return v;
  return String(v);
}

/** Mirrors `evaluateCondition` in `packages/workflow/src/nodes/if.ts`,
 * scoped to the (dataType, operation) pairs `assignReviewers` actually
 * uses. `exists` is NOT dataType-agnostic in the real executor — it
 * type-checks (`evalNumber` requires `typeof left === 'number'`,
 * `evalObject` requires a plain object, `evalBoolean` requires an actual
 * boolean) — so this dispatches on dataType first, the same way the real
 * `switch (cond.dataType)` does, rather than checking `operation` alone.
 * An unhandled pair throws, so a gate that gains an operation this helper
 * has not been taught fails the test that exercises it instead of
 * evaluating silently wrong. */
function evaluateAssignCondition(condition: IfCondition, ctx: TemplateContext): boolean {
  const left = evaluateExpression(parseExpression(condition.left), ctx);
  const right = condition.right;
  switch (condition.dataType) {
    case "string":
      switch (condition.operation) {
        case "exists":
          return left !== undefined && left !== null;
        case "isNotEmpty":
          return typeof left === "string" && left.length > 0;
        case "equals":
          return left === right;
        case "doesNotContain":
          return !asString(left).includes(asString(right));
      }
      break;
    case "number":
      if (condition.operation === "exists") return typeof left === "number" && !Number.isNaN(left);
      break;
    case "boolean":
      if (condition.operation === "isTrue") return left === true;
      if (condition.operation === "isFalse") return left === false;
      break;
    case "array":
      if (condition.operation === "isEmpty") return !Array.isArray(left) || left.length === 0;
      if (condition.operation === "lengthGreaterThan") return Array.isArray(left) && left.length > asNumber(right);
      break;
    case "object":
      if (condition.operation === "exists") {
        return left !== null && typeof left === "object" && !Array.isArray(left);
      }
      break;
  }
  throw new Error(`this test evaluates no ${condition.dataType}/${condition.operation} condition`);
}

function assignIfNode(id: string): IfNode {
  const definition = definitionOf(ASSIGN_ID);
  const node = definition.nodes.find((n): n is IfNode => n.type === "if" && n.id === id);
  if (!node) throw new Error(`no if node "${id}"`);
  return node;
}

function assignForeachNode(id: string): ForeachNode {
  const definition = definitionOf(ASSIGN_ID);
  const node = definition.nodes.find((n): n is ForeachNode => n.type === "foreach" && n.id === id);
  if (!node) throw new Error(`no foreach node "${id}"`);
  return node;
}

/** A context in which `shortlist` and `select` have completed, for the
 * branch-A coverage gate. Every count is derived from the list beside it,
 * so a test states the lists and the fixture cannot disagree with itself. */
function coverageContext(requiredOwners: string[], coveredOwners: string[], assignees: string[]): TemplateContext {
  return {
    trigger: eventTrigger(webhookBody("opened")),
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

/** Same shape, for the branch-B (swap) coverage gate, whose node ids differ. */
function swapCoverageContext(requiredOwners: string[], coveredOwners: string[], assignees: string[]): TemplateContext {
  return {
    trigger: commentEventTrigger(commentBody("an-engineer", "sorry, can't do this one")),
    nodes: {
      shortlist_swap: {
        result: {
          text: "",
          output: { requiredOwners, requiredOwnerCount: requiredOwners.length, unmatchedPaths: [] },
          usage: {},
        },
      },
      select_swap: {
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

function coverageGatePasses(ctx: TemplateContext): boolean {
  const gate = assignIfNode("coverage_met");
  return gate.conditions.every((condition) => evaluateAssignCondition(condition, ctx));
}

function swapCoverageGatePasses(ctx: TemplateContext): boolean {
  const gate = assignIfNode("swap_coverage_met");
  return gate.conditions.every((condition) => evaluateAssignCondition(condition, ctx));
}

const GROUP_ONE = "@example-org/group-one";
const GROUP_TWO = "@example-org/group-two";

/** An `issue_comment` webhook body on a pull request — the shape
 * `payload.issue.pull_request` existing, not `payload.pull_request`, is how
 * GitHub says the commented-on issue is a pull request. */
function commentBody(commenterLogin: string, text: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    action: "created",
    repository: {
      full_name: `${REPO_OWNER}/${REPO_NAME}`,
      name: REPO_NAME,
      owner: { login: REPO_OWNER },
    },
    sender: { id: 5252, login: commenterLogin },
    issue: {
      number: PR_NUMBER,
      pull_request: { url: `https://api.github.com/repos/${REPO_OWNER}/${REPO_NAME}/pulls/${PR_NUMBER}` },
    },
    comment: { user: { login: commenterLogin }, body: text },
    ...overrides,
  };
}

function commentEventTrigger(body: Record<string, unknown>): WorkflowTriggerPayload {
  const repository = body.repository as { full_name: string };
  return {
    type: "event",
    triggerId: "evtsub_02",
    timestamp: "2026-08-17T09:30:01.000Z",
    data: {
      key: "github.issue_comment.created",
      summary: `${repository.full_name} — issue_comment created`,
      refs: { repo: repository.full_name, installation_id: "77" },
      payload: body,
    },
    metadata: { eventId: "evt_02", service: "github" },
  };
}

describe(ASSIGN_ID, () => {
  const definition = definitionOf(ASSIGN_ID);
  const template = templateById(ASSIGN_ID);

  it("carries a dag/v1 definition", () => {
    expect(definition.version).toBe("dag/v1");
    expect(definition.nodes.length).toBeGreaterThan(0);
    expect(definition.edges.length).toBeGreaterThan(0);
  });

  it("stays out of this file's self-validated set — it now calls Google Calendar and Slack too", () => {
    // Real cross-service validation (github + google_calendar + slack
    // together) runs in `packages/api`'s suite, which loads every plugin.
    expect(githubOnly.map((t) => t.id)).not.toContain(ASSIGN_ID);
  });

  it("arms no schedule and takes only install-time configuration plus the hidden event payload", () => {
    expect(template.schedule).toBeUndefined();
    const trigger = definition.nodes.find((node) => node.type === "trigger");
    const schema = trigger?.type === "trigger" ? trigger.dataSchema : undefined;
    expect(Object.keys(schema ?? {})).toEqual([
      "repository",
      "codeownersPath",
      "rosterOwner",
      "rosterRepository",
      "rosterPath",
      "payload",
    ]);
    expect(schema?.payload?.hidden).toBe(true);
  });

  it("stops a hand-started run at the branch gates, not on a blank-field error", () => {
    // This template carries NO `policy.onUnresolvedPath: "fail"`, unlike the
    // review template. The branch gates make it unnecessary — a run with no
    // recognizable event reaches `unrecognized_trigger` before any node reads
    // the payload — and the policy is what forced the roster to be
    // mandatory, because an `llm` prompt is an enforceable surface and a
    // missing roster fails its read.
    expect(definition.policy?.onUnresolvedPath).toBeUndefined();
    const stop = nodeOf(definition, "unrecognized_trigger");
    const message = isRecord(stop) && typeof stop.message === "string" ? stop.message : "";
    expect(isRecord(stop) && stop.outcome).toBe("failure");
    expect(message).toContain("github.pull_request.opened");
    expect(message).toContain("github.pull_request.ready_for_review");
    expect(message).toContain("github.issue_comment.created");
  });

  it("takes the roster as an input, because no action lists a team's members", () => {
    const teamCalls = githubPlugin.actions.filter((a) => JSON.stringify(a).includes("/teams/"));
    expect(teamCalls.map((a) => a.id)).toEqual([]);

    const trigger = definition.nodes.find((node) => node.type === "trigger");
    const schema = trigger?.type === "trigger" ? trigger.dataSchema : undefined;
    expect(schema?.rosterPath?.required).toBe(true);
    expect(schema?.rosterPath?.description).toContain("groups");
  });

  it("subscribes only to actions the trigger catalog actually offers", () => {
    const catalog = githubTriggerDefs.flatMap((def) => def.catalog.map((entry) => entry.key));
    const message = String(nodeOf(definition, "unrecognized_trigger") as { message?: string }).valueOf();
    for (const key of ["github.pull_request.opened", "github.pull_request.ready_for_review", "github.issue_comment.created"]) {
      expect(catalog).toContain(key);
    }
    expect(typeof message).toBe("string");
  });
});

describe(`${ASSIGN_ID} — branch selection`, () => {
  const definition = definitionOf(ASSIGN_ID);

  it("routes a fresh pull request event into branch A", () => {
    const gate = assignIfNode("is_new_pull_request");
    const ctx: TemplateContext = { trigger: eventTrigger(webhookBody("opened")) };
    expect(evaluateAssignCondition(gate.conditions[0]!, ctx)).toBe(true);
    expect(evaluateAssignCondition(gate.conditions[1]!, ctx)).toBe(true);
  });

  it("also routes ready_for_review, and nothing else, into branch A", () => {
    const gate = assignIfNode("is_new_pull_request");
    const ready: TemplateContext = { trigger: eventTrigger(webhookBody("ready_for_review")) };
    expect(evaluateAssignCondition(gate.conditions[1]!, ready)).toBe(true);
    const synchronize: TemplateContext = { trigger: eventTrigger(webhookBody("synchronize")) };
    expect(evaluateAssignCondition(gate.conditions[1]!, synchronize)).toBe(false);
  });

  it("routes an issue_comment on a pull request into branch B", () => {
    const ctx: TemplateContext = { trigger: commentEventTrigger(commentBody("an-engineer", "sorry, can't do this one")) };
    expect(evaluateAssignCondition(assignIfNode("is_comment_event").conditions[0]!, ctx)).toBe(true);
    expect(evaluateAssignCondition(assignIfNode("is_review_comment").conditions[0]!, ctx)).toBe(true);
  });

  it("ends a comment on a plain issue as a quiet success, not a failed run", () => {
    // The comment subscription cannot be narrowed to pull requests, so
    // every issue comment in the repository starts a run. A failure per
    // issue comment would fill the run list with red naming no fixable
    // problem.
    const body = commentBody("an-engineer", "not a pull request comment");
    delete (body.issue as Record<string, unknown>).pull_request;
    const ctx: TemplateContext = { trigger: commentEventTrigger(body) };
    // It IS a comment event...
    expect(evaluateAssignCondition(assignIfNode("is_comment_event").conditions[0]!, ctx)).toBe(true);
    // ...but not on a pull request.
    expect(evaluateAssignCondition(assignIfNode("is_review_comment").conditions[0]!, ctx)).toBe(false);

    const miss = definition.edges.filter((e) => e.from === "is_review_comment" && e.fromOutput === "false");
    expect(miss.map((e) => e.to)).toEqual(["not_a_pull_request_comment"]);
    const stop = nodeOf(definition, "not_a_pull_request_comment");
    expect(isRecord(stop) && stop.outcome).toBe("success");
  });

  it("stops with the corrective message only when no event arrived at all", () => {
    // A hand-started run reaches this. A comment on an issue does NOT —
    // that is ordinary traffic for the comment subscription, and it ends
    // in a success stop instead.
    expect(definition.edges.filter((e) => e.from === "is_new_pull_request" && e.fromOutput === "false").map((e) => e.to)).toEqual(["is_comment_event"]);
    expect(definition.edges.filter((e) => e.from === "is_comment_event" && e.fromOutput === "false").map((e) => e.to)).toEqual(["unrecognized_trigger"]);
    expect(definition.edges.filter((e) => e.from === "is_comment_event" && e.fromOutput === "true").map((e) => e.to)).toEqual(["is_review_comment"]);
  });

  it("reads owner, repo and pull number from the event, not from a typed field", () => {
    const codeowners = toolNode(definition, "codeowners");
    expect(codeowners.params.owner).toBe("{{ trigger.data.payload.repository.owner.login }}");
    expect(codeowners.params.repo).toBe("{{ trigger.data.payload.repository.name }}");
    const pull = toolNode(definition, "pull_request");
    expect(pull.params.pullNumber).toBe("{{ trigger.data.payload.pull_request.number }}");
  });
});

describe(`${ASSIGN_ID} — the coverage rule (branch A)`, () => {
  it("declares a gate the if executor can run", () => {
    const gate = assignIfNode("coverage_met");
    expect(gate.combinator).toBeUndefined(); // `and`
    for (const condition of gate.conditions) {
      expect(isIfOperationSupported(condition.dataType, condition.operation)).toBe(true);
    }
    expect(gate.conditions[0]?.left).toBe(
      "nodes.shortlist.result.output.requiredOwnerCount == nodes.select.result.output.coveredOwnerCount",
    );
    expect(gate.conditions[2]?.left).toBe(
      "nodes.select.result.output.assigneeCount <= nodes.shortlist.result.output.requiredOwnerCount",
    );
  });

  it("never shows the selection step the count the gate compares against", () => {
    const select = definitionOf(ASSIGN_ID).nodes.find((n): n is LlmNode => n.type === "llm" && n.id === "select");
    expect(select?.prompt).toContain("{{ nodes.shortlist.result.output.requiredOwners }}");
    expect(select?.prompt).not.toContain("requiredOwnerCount");
  });

  it("passes one person who belongs to both groups", () => {
    const ctx = coverageContext([GROUP_ONE, GROUP_TWO], [GROUP_ONE, GROUP_TWO], ["reviewer-one"]);
    expect(coverageGatePasses(ctx)).toBe(true);
  });

  it("refuses a choice that covers one of two groups", () => {
    const ctx = coverageContext([GROUP_ONE, GROUP_TWO], [GROUP_ONE], ["reviewer-one"]);
    expect(coverageGatePasses(ctx)).toBe(false);
  });

  it("refuses a rider: a real cover plus one name nobody needed", () => {
    const ctx = coverageContext(
      [GROUP_ONE, GROUP_TWO],
      [GROUP_ONE, GROUP_TWO],
      ["reviewer-one", "reviewer-two", "rider-nobody-asked-for"],
    );
    expect(coverageGatePasses(ctx)).toBe(false);
  });

  it("refuses to assign when no owner rule matched the changed paths", () => {
    const ctx = coverageContext([], [], []);
    expect(evaluateAssignCondition(assignIfNode("coverage_met").conditions[0]!, ctx)).toBe(true);
    expect(coverageGatePasses(ctx)).toBe(false);
  });
});

describe(`${ASSIGN_ID} — what it writes and who it tells (branch A)`, () => {
  const definition = definitionOf(ASSIGN_ID);

  it("writes the assignees field, and never a reviewer request", () => {
    const assign = toolNode(definition, "assign");
    expect(assign.action).toBe("update_pull_request");
    expect(assign.params.assignees).toBe("{{ nodes.select.result.output.assignees }}");
    expect(assign.params.pullNumber).toBe("{{ trigger.data.payload.pull_request.number }}");
    expect(JSON.stringify(definition)).not.toContain("requested_reviewers");
  });

  it("reaches the write only through the coverage gate", () => {
    const intoAssign = definition.edges.filter((edge) => edge.to === "assign");
    expect(intoAssign.map((edge) => `${edge.from}:${edge.fromOutput ?? "-"}`)).toEqual(["coverage_met:true"]);
    const miss = definition.edges.filter((edge) => edge.from === "coverage_met" && edge.fromOutput === "false");
    expect(miss.map((edge) => edge.to)).toEqual(["report_gap"]);
  });

  it("reads the pull request back, because the write cannot report itself", () => {
    const update = githubPlugin.actions.find((a) => a.id === "github.update_pull_request");
    expect(update).toBeDefined();
    const verify = toolNode(definition, "verify");
    expect(verify.action).toBe("inspect_pull_request");
    expect(definition.edges.filter((e) => e.from === "assign").map((e) => e.to)).toEqual(["verify"]);
  });

  it("reports only the names the read-back confirmed", () => {
    const report = nodeOf(definition, "report");
    const prompt = isRecord(report) && typeof report.prompt === "string" ? report.prompt : "";
    expect(prompt).toContain("{{ nodes.confirm.result.output.dropped }}");
    expect(prompt).toContain("{{ nodes.verify.result.assignees }}");
    expect(prompt).not.toContain("{{ nodes.select.result.output.assignees }}");
  });

  it("says in the report that Slack DMs were already sent, not still to do", () => {
    const report = nodeOf(definition, "report");
    const prompt = isRecord(report) && typeof report.prompt === "string" ? report.prompt : "";
    expect(prompt).toContain("also sent a Slack DM");
    expect(prompt).toContain("say that happened, do not describe it as still to do");
  });

  it("DMs only assignees the read-back confirmed landed, never the ones select chose", () => {
    // `withSlack` (select's output) is the intent; `landedWithSlack`
    // (confirm's output) is what actually happened. The foreach loop that
    // sends the DM must read the latter.
    const confirm = definitionOf(ASSIGN_ID).nodes.find((n): n is LlmNode => n.type === "llm" && n.id === "confirm");
    expect(confirm?.prompt).toContain("{{ nodes.select.result.output.withSlack }}");
    const schema = confirm?.outputSchema;
    const properties = isRecord(schema) && isRecord(schema.properties) ? schema.properties : {};
    expect(properties.landedWithSlack).toBeDefined();

    const dm = assignForeachNode("dm_assignees");
    expect(dm.items).toBe("{{ nodes.confirm.result.output.landedWithSlack }}");
    expect(dm.body.type).toBe("tool");
    if (dm.body.type === "tool") {
      expect(dm.body.service).toBe("slack");
      expect(dm.body.action).toBe("dm_user");
      expect(dm.body.params.user).toBe("{{ item.slackUserId }}");
    }
    // `dm_assignees` runs BEFORE `report`, not beside it: every foreach must
    // report what its own per-run cap dropped, and only a downstream node
    // can read `nodes.dm_assignees.result.truncatedCount`.
    expect(definition.edges.filter((e) => e.from === "confirm").map((e) => e.to)).toEqual(["dm_assignees"]);
    expect(definition.edges.filter((e) => e.from === "dm_assignees").map((e) => e.to)).toEqual(["dm_author_success"]);
    const report = nodeOf(definition, "report");
    const reportPrompt = isRecord(report) && typeof report.prompt === "string" ? report.prompt : "";
    expect(reportPrompt).toContain("{{ nodes.dm_assignees.result.truncatedCount }}");
  });

  it("DMs the pull request author from a foreach, not an if — a foreach body cannot branch", () => {
    // `authorWithSlack` holds at most one entry so both report tails can
    // reuse the same zero-or-one-item loop instead of a conditional a
    // foreach body's node union does not allow.
    const success = assignForeachNode("dm_author_success");
    const failure = assignForeachNode("dm_author_failure");
    expect(success.items).toBe("{{ nodes.shortlist.result.output.authorWithSlack }}");
    expect(failure.items).toBe("{{ nodes.shortlist.result.output.authorWithSlack }}");
    expect(success.maxItems).toBe(1);
    expect(failure.maxItems).toBe(1);
    // Each runs before its tail's terminal node, so that node's own text can
    // report the DM loop's truncatedCount.
    expect(definition.edges.filter((e) => e.from === "dm_author_success").map((e) => e.to)).toEqual(["report"]);
    expect(definition.edges.filter((e) => e.from === "report_gap").map((e) => e.to)).toEqual(["dm_author_failure"]);
    expect(definition.edges.filter((e) => e.from === "dm_author_failure").map((e) => e.to)).toEqual(["assignment_failed"]);
    const report = nodeOf(definition, "report");
    const reportPrompt = isRecord(report) && typeof report.prompt === "string" ? report.prompt : "";
    expect(reportPrompt).toContain("{{ nodes.dm_author_success.result.truncatedCount }}");
    const stop = nodeOf(definition, "assignment_failed");
    const message = isRecord(stop) && typeof stop.message === "string" ? stop.message : "";
    expect(message).toContain("{{ nodes.dm_author_failure.result.truncatedCount }}");
  });

  it("renders a real recipient list against a realistic context", () => {
    const ctx: TemplateContext = {
      trigger: eventTrigger(webhookBody("opened")),
      nodes: {
        confirm: {
          result: {
            text: "",
            output: {
              landed: ["reviewer-one"],
              dropped: [],
              landedWithSlack: [{ handle: "reviewer-one", slackUserId: "U0REVIEWERONE" }],
            },
            usage: {},
          },
        },
      },
    };
    const dm = assignForeachNode("dm_assignees");
    const items = evaluateExpression(parseExpression(dm.items.replace(/^\{\{\s*|\s*\}\}$/g, "")), ctx);
    expect(items).toEqual([{ handle: "reviewer-one", slackUserId: "U0REVIEWERONE" }]);
  });

  it("leaves a pull request that somebody already owns alone", () => {
    const gate = assignIfNode("assignable");
    expect(gate.conditions.map((c) => `${c.left}:${c.operation}`)).toEqual([
      "nodes.pull_request.result.state:equals",
      "nodes.pull_request.result.draft:isFalse",
      "nodes.pull_request.result.assignees:isEmpty",
    ]);
  });

  it("names nobody real, and keeps its example groups to placeholders", () => {
    const handles = JSON.stringify(definitionOf(ASSIGN_ID)).match(/@[a-z][a-z0-9/-]+/gi) ?? [];
    expect(handles.filter((handle) => !handle.startsWith("@handle") && !handle.startsWith("@org/team"))).toEqual([]);
  });
});

describe(`${ASSIGN_ID} — the roster is optional`, () => {
  const definition = definitionOf(ASSIGN_ID);

  it("gates only on CODEOWNERS, in both branches", () => {
    // A repository with no roster still gets reviewers. `read_repo_file`
    // answers 404 with success:false, so a missing roster FAILS its node —
    // an `if` condition is exempt from the template audit, which is why a
    // roster read that never resolved is a question here rather than a fault.
    for (const id of ["inputs_readable", "swap_inputs_readable"]) {
      const gate = assignIfNode(id);
      expect(gate.conditions).toHaveLength(1);
      expect(gate.conditions[0]?.left).toContain("codeowners");
      expect(gate.conditions[0]?.left).not.toContain("roster");
    }
  });

  it("tells both shortlist steps how to build candidates without a roster", () => {
    for (const id of ["shortlist", "shortlist_swap"]) {
      const node = definition.nodes.find((n): n is LlmNode => n.type === "llm" && n.id === id);
      const prompt = node?.prompt ?? "";
      expect(prompt).toContain("WHEN THE ROSTER IS EMPTY");
      // A plain @handle is a person and can be assigned.
      expect(prompt).toContain("A token written @handle with NO slash is one person");
      // A team token is NOT assignable through the assignees field, so it is
      // reported rather than silently dropped into a name GitHub discards.
      expect(prompt).toContain("names a GitHub TEAM");
      expect(prompt).toContain("rosterProblems");
      // The fallback must not bypass the exclusion step — branch B drops the
      // decliner there, and skipping it would re-assign the person who just
      // said no.
      expect(prompt).toContain("apply step 4 to these candidates as well");
    }
  });

  it("still fails when CODEOWNERS itself is unreadable, naming both causes", () => {
    const stop = nodeOf(definition, "no_inputs");
    const message = isRecord(stop) && typeof stop.message === "string" ? stop.message : "";
    expect(isRecord(stop) && stop.outcome).toBe("failure");
    // "empty" and "could not be read" are different problems with different
    // fixes, and the run cannot tell them apart — so it names both.
    expect(message).toContain("is empty, or could not be read at all");
    expect(message).toContain("can read that repository");
    expect(message).toContain("roster is optional");
  });
});

describe(`${ASSIGN_ID} — decline swap (branch B)`, () => {
  const definition = definitionOf(ASSIGN_ID);

  it("ignores a comment from a bot, before any GitHub read", () => {
    const gate = assignIfNode("comment_not_bot");
    expect(gate.conditions[0]?.left).toBe("trigger.data.payload.comment.user.login");
    expect(gate.conditions[0]?.operation).toBe("doesNotContain");
    const botCtx: TemplateContext = { trigger: commentEventTrigger(commentBody("valet-bot[bot]", "sorry, can't do this one")) };
    expect(evaluateAssignCondition({ ...gate.conditions[0]!, dataType: "string" }, botCtx)).toBe(false);
    // The read that would otherwise run is gated behind this, so a busy
    // repository's bot comments cost nothing.
    expect(definition.edges.filter((e) => e.from === "comment_not_bot").map((e) => `${e.to}:${e.fromOutput}`).sort()).toEqual([
      "comment_from_bot:false",
      "pull_request_at_decline:true",
    ]);
  });

  it("reads the pull request fresh, from the comment's issue number", () => {
    const read = toolNode(definition, "pull_request_at_decline");
    expect(read.action).toBe("inspect_pull_request");
    expect(read.params.pullNumber).toBe("{{ trigger.data.payload.issue.number }}");
  });

  it("does nothing when the commenter is not a current assignee", () => {
    const gate = assignIfNode("commenter_is_assignee");
    expect(gate.conditions.map((c) => c.left)).toEqual([
      "nodes.pull_request_at_decline.result.state",
      "nodes.pull_request_at_decline.result.draft",
      "trigger.data.payload.comment.user.login in nodes.pull_request_at_decline.result.assignees",
    ]);
    for (const condition of gate.conditions) {
      expect(isIfOperationSupported(condition.dataType, condition.operation)).toBe(true);
    }
    const notAssigned: TemplateContext = {
      trigger: commentEventTrigger(commentBody("a-passerby", "sorry, can't do this one")),
      nodes: { pull_request_at_decline: { result: { state: "open", draft: false, assignees: ["reviewer-one"] } } },
    };
    expect(evaluateAssignCondition(gate.conditions[2]!, notAssigned)).toBe(false);
    const assigned: TemplateContext = {
      trigger: commentEventTrigger(commentBody("reviewer-one", "sorry, can't do this one")),
      nodes: { pull_request_at_decline: { result: { state: "open", draft: false, assignees: ["reviewer-one"] } } },
    };
    expect(evaluateAssignCondition(gate.conditions[2]!, assigned)).toBe(true);
    const stop = nodeOf(definition, "not_a_current_reviewer");
    expect(isRecord(stop) && stop.outcome).toBe("success");
  });

  it("classifies before it reselects, and stops quietly on a non-decline", () => {
    const classify = definition.nodes.find((n): n is LlmNode => n.type === "llm" && n.id === "classify_decline");
    expect(classify?.model).toBe("claude-haiku-4-5");
    expect(classify?.prompt).toContain("{{ trigger.data.payload.comment.body }}");
    const gate = assignIfNode("is_decline");
    expect(gate.conditions[0]?.left).toBe("nodes.classify_decline.result.output.isDecline");
    const notDecline = definition.edges.filter((e) => e.from === "is_decline" && e.fromOutput === "false");
    expect(notDecline.map((e) => e.to)).toEqual(["not_a_decline"]);
    const stop = nodeOf(definition, "not_a_decline");
    expect(isRecord(stop) && stop.outcome).toBe("success");
  });

  it("names the decliner in the reselection, not a run-form field", () => {
    const shortlistSwap = definition.nodes.find((n): n is LlmNode => n.type === "llm" && n.id === "shortlist_swap");
    expect(shortlistSwap?.prompt).toContain("{{ trigger.data.payload.comment.user.login }}");
    expect(JSON.stringify(definition)).not.toContain("excludeHandles");
  });

  it("keeps everybody still assigned, and reselects only for the gap", () => {
    const selectSwap = definition.nodes.find((n): n is LlmNode => n.type === "llm" && n.id === "select_swap");
    const prompt = selectSwap?.prompt ?? "";
    expect(prompt).toContain("keepers is that assignee list with the decliner removed");
    expect(prompt).toContain("Everybody in keepers stays in your final assignees list");
    const schema = selectSwap?.outputSchema;
    const properties = isRecord(schema) && isRecord(schema.properties) ? schema.properties : {};
    expect(properties.newAssignees).toBeDefined();
  });

  it("declares the swap coverage gate with no upper-bound condition — keepers are not a choice", () => {
    const gate = assignIfNode("swap_coverage_met");
    expect(gate.conditions.length).toBe(2);
    expect(gate.conditions[0]?.left).toBe(
      "nodes.shortlist_swap.result.output.requiredOwnerCount == nodes.select_swap.result.output.coveredOwnerCount",
    );
    expect(gate.conditions[1]?.left).toBe("nodes.select_swap.result.output.assignees");
  });

  it("passes when the reselection covers what the decliner left uncovered", () => {
    const ctx = swapCoverageContext([GROUP_ONE, GROUP_TWO], [GROUP_ONE, GROUP_TWO], ["reviewer-one", "reviewer-two"]);
    expect(swapCoverageGatePasses(ctx)).toBe(true);
  });

  it("refuses when an owner is still uncovered after the reselection", () => {
    const ctx = swapCoverageContext([GROUP_ONE, GROUP_TWO], [GROUP_ONE], ["reviewer-one"]);
    expect(swapCoverageGatePasses(ctx)).toBe(false);
  });

  it("writes keepers plus the replacement as one full assignee list", () => {
    const assign = toolNode(definition, "assign_swap");
    expect(assign.action).toBe("update_pull_request");
    expect(assign.params.assignees).toBe("{{ nodes.select_swap.result.output.assignees }}");
    expect(assign.params.pullNumber).toBe("{{ trigger.data.payload.issue.number }}");
  });

  it("replies on the pull request, and DMs only the new assignee", () => {
    const reply = toolNode(definition, "reply_on_pr");
    expect(reply.action).toBe("create_comment");
    expect(reply.params.issueNumber).toBe("{{ trigger.data.payload.issue.number }}");

    const confirmSwap = definition.nodes.find((n): n is LlmNode => n.type === "llm" && n.id === "confirm_swap");
    expect(confirmSwap?.prompt).toContain("{{ nodes.select_swap.result.output.newAssignees }}");
    // Never `assignees` — a keeper already landed in an earlier run, and
    // re-announcing them here would tell somebody they were assigned twice.
    expect(confirmSwap?.prompt).not.toContain("{{ nodes.select_swap.result.output.assignees }}");

    const dm = assignForeachNode("dm_new_assignee");
    expect(dm.items).toBe("{{ nodes.confirm_swap.result.output.landedWithSlack }}");
    // `reply_on_pr` needs nothing from the DM loops, so it runs beside them.
    // Both DM loops still run before `report_swap`, not beside it, so its
    // prompt can report what each one's own cap dropped.
    expect(definition.edges.filter((e) => e.from === "confirm_swap").map((e) => e.to).sort()).toEqual([
      "dm_new_assignee",
      "reply_on_pr",
    ]);
    expect(definition.edges.filter((e) => e.from === "dm_new_assignee").map((e) => e.to)).toEqual([
      "dm_author_swap_success",
    ]);
    expect(definition.edges.filter((e) => e.from === "dm_author_swap_success").map((e) => e.to)).toEqual([
      "report_swap",
    ]);
    const report = nodeOf(definition, "report_swap");
    const reportPrompt = isRecord(report) && typeof report.prompt === "string" ? report.prompt : "";
    expect(reportPrompt).toContain("{{ nodes.dm_new_assignee.result.truncatedCount }}");
    expect(reportPrompt).toContain("{{ nodes.dm_author_swap_success.result.truncatedCount }}");
  });

  it("guards against re-triggering on its own reply", () => {
    // A reply this workflow posts is itself an issue_comment event. The
    // classifier reading it and answering false is the loop guard, not a
    // bot-login check — the model.
    const classify = definition.nodes.find((n): n is LlmNode => n.type === "llm" && n.id === "classify_decline");
    expect(classify?.prompt).toContain("reassignment this workflow itself just posted");
  });

  it("cannot rely on the bot-login check for that guard — the reply posts as a real account", () => {
    // `reply_on_pr` runs under `credential: "user"`, the run owner's own
    // GitHub account, so its comment's `user.login` is a real handle that
    // never contains "[bot]". `comment_not_bot` therefore lets the reply
    // straight through, same as `commenter_is_assignee` would if the run
    // owner happens to also be a current assignee. The classifier reading
    // its own text and answering false is genuinely the only thing that
    // stops the loop — this pins the fact the comment above only asserts.
    const reply = toolNode(definition, "reply_on_pr");
    expect(reply.credential).toBe("user");
    const gate = assignIfNode("comment_not_bot");
    expect(gate.conditions[0]?.operation).toBe("doesNotContain");
    expect(gate.conditions[0]?.right).toBe("[bot]");
  });

  it("names nobody real in the swap branch either", () => {
    const shortlistSwap = definition.nodes.find((n): n is LlmNode => n.type === "llm" && n.id === "shortlist_swap");
    const handles = JSON.stringify(shortlistSwap ?? {}).match(/@[a-z][a-z0-9/-]+/gi) ?? [];
    expect(handles.filter((handle) => !handle.startsWith("@handle") && !handle.startsWith("@org/team"))).toEqual([]);
  });
});

describe(`${ASSIGN_ID} — card copy`, () => {
  const template = templateById(ASSIGN_ID);
  const caveatList = template.caveats ?? [];
  const caveats = caveatList.join("\n");

  it("keeps the description to two short paragraphs", () => {
    const paragraphs = template.description.split("\n\n");
    expect(paragraphs.length).toBe(2);
    for (const paragraph of paragraphs) {
      expect(paragraph.length).toBeLessThan(320);
    }
  });

  it("says what it needs and that triggers are a manual step, in the description", () => {
    expect(template.description).toContain("GitHub, Google Calendar, and Slack");
    expect(template.description).toContain("Install it, then add its GitHub triggers yourself");
  });

  it("lists slack among the apps, now that it sends DMs", () => {
    expect(template.apps).toContain("slack");
    expect(template.apps).toContain("google_calendar");
    expect(template.apps).toContain("github");
  });

  it("leads the caveats with what install arms, and the filter that scopes it", () => {
    expect(caveatList[0]).toContain("arms two triggers");
    expect(caveatList[0]).toContain("owner/name");
    // The manual arming instructions are gone, because install does it now.
    expect(caveatList[0]).not.toContain("New trigger");
  });

  it("keeps the caveats to a couple of paragraphs — a reader has to actually read this", () => {
    expect(caveatList.length).toBeLessThanOrEqual(4);
    for (const entry of caveatList) expect(entry.length).toBeLessThan(400);
  });

  it("still names the roster as the source the platform itself cannot supply", () => {
    expect(caveats).toContain("The roster is the only source of group membership, working hours, calendars and Slack ids");
  });

  it("still states the decline-classifier's own limit", () => {
    expect(caveats).toContain("A decline is a model's judgment on one comment, not a keyword match");
  });

  it("no longer claims a swap is unbuilt", () => {
    expect(caveats).not.toContain("cannot swap a reviewer who declines");
    expect(caveats).not.toContain("exclude field");
  });

  it("no longer promises a per-run pull request number or exclude field", () => {
    expect(caveats).not.toContain("Leave the pull request number and the exclude field empty");
    expect(JSON.stringify(template)).not.toContain("excludeHandles");
  });
});
