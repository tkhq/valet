/**
 * `/api/workflows` (Phase 5 plan decision 18). Definitions + runs, owner-
 * scoped to the authenticated principal exactly like `routes/sessions.ts`
 * (cross-owner access 404s, never 403s — an owned row and a missing row are
 * indistinguishable to the caller).
 *
 * All definition/run logic lives in `../workflows/service.ts` (shared with
 * the agent-facing workflows action plugin); this file is HTTP plumbing.
 */
import { Hono } from "hono";
import { NotFoundError } from "@valet/shared";
import type { AppEnv } from "../env.js";
import { WorkflowCursorError, type ValidateEnvironment } from "@valet/workflow";
import {
  cancelWorkflowRun,
  createWorkflowDefinition,
  deleteWorkflowDefinition,
  getWorkflowDefinition,
  getWorkflowRunDetail,
  getWorkflowVersion,
  isAuthorizedForOwner,
  isRunOutcome,
  isRunStatus,
  listRunsForOwner,
  listWorkflowDefinitions,
  listWorkflowRuns,
  listWorkflowVersions,
  resolveWorkflowApproval,
  retryWorkflowRun,
  startWorkflowRun,
  updateWorkflowDefinition,
  validateDefinitionInput,
  RUN_OUTCOME_VALUES,
  RUN_PAGE_LIMIT_MAX,
  RUN_STATUS_VALUES,
  type WorkflowOwner,
  type WorkflowOwnerRef,
  type WorkflowOwnerType,
  type WorkflowServiceDeps,
} from "../workflows/service.js";
import {
  deleteWorkflowWebhook,
  getWorkflowWebhook,
  mintOrRotateWorkflowWebhook,
  workflowWebhookUrl,
} from "../workflows/webhook-service.js";
import {
  createWorkflowSchedule,
  deleteWorkflowSchedule,
  listWorkflowSchedules,
  type WorkflowScheduleSummary,
} from "../workflows/schedule-service.js";
import { buildValidateEnvironment } from "../workflows/validation-env.js";
import { allowWorkflowPermissions, analyzeWorkflowPermissions } from "../workflows/permissions.js";
import { parseRepoInput, SkillSourceInputError } from "../services/skill-sources.js";
import {
  GitHubSkillRepoReader,
  SkillRepoReadError,
  SkillRepoTimeoutError,
  type SkillRepoFile,
} from "../services/skill-repo-reader.js";
import type {
  AllowWorkflowPermissionsRequest,
  AllowWorkflowPermissionsResponse,
  CancelWorkflowRunResponse,
  CreateWorkflowRequest,
  CreateWorkflowResponse,
  GetWorkflowPermissionsResponse,
  GetWorkflowImportFileResponse,
  ListAllWorkflowRunsResponse,
  CreateScheduleOnWorkflowRequest,
  CreateWorkflowScheduleResponse,
  DeleteWorkflowScheduleResponse,
  DeleteWorkflowWebhookResponse,
  ListWorkflowSchedulesResponse,
  WorkflowScheduleWire,
  GetWorkflowResponse,
  GetWorkflowVersionResponse,
  ListWorkflowRunsResponse,
  ListWorkflowVersionsResponse,
  ListWorkflowsResponse,
  ResolveWorkflowApprovalRequest,
  ResolveWorkflowApprovalResponse,
  RetryWorkflowRunResponse,
  StartWorkflowRunRequest,
  StartWorkflowRunResponse,
  UpdateWorkflowRequest,
  UpdateWorkflowResponse,
  WorkflowWebhookResponse,
} from "../wire/types.js";

export const workflowsRouter = new Hono<AppEnv>();

/** An empty query value means "not set": a client that always sends the
 * field must not get a 400 for leaving it blank. */
function blankToUndefined(value: string | undefined): string | undefined {
  return value === undefined || value === "" ? undefined : value;
}

/** Parses `?limit=` for the run lists. Both list handlers share the range. */
function parseRunLimit(raw: string | undefined): { limit?: number } | { error: string } {
  const value = blankToUndefined(raw);
  if (value === undefined) return {};
  const limit = Number(value);
  if (!Number.isInteger(limit) || limit < 1 || limit > RUN_PAGE_LIMIT_MAX) {
    return { error: `limit must be an integer from 1 to ${RUN_PAGE_LIMIT_MAX}` };
  }
  return { limit };
}

function serviceCtx(c: {
  var: { providers: WorkflowServiceDeps; user: { id: string; orgId: string } };
}): { deps: WorkflowServiceDeps; owner: WorkflowOwner; env: ValidateEnvironment } {
  const { db, workflowStore, workflowRunHost, actionPluginByService } = c.var.providers;
  return {
    deps: { db, workflowStore, workflowRunHost, actionPluginByService },
    owner: { userId: c.var.user.id, orgId: c.var.user.orgId },
    env: buildValidateEnvironment(actionPluginByService),
  };
}

const OWNER_TYPES: ReadonlySet<string> = new Set(["user", "team", "org"]);

function isWorkflowOwnerType(value: string): value is WorkflowOwnerType {
  return OWNER_TYPES.has(value);
}

/** The `?ownerType=&ownerId=` filter, or undefined when absent. Returns an
 * error string when one half is present and the other is not — the same
 * shape `GET /api/assistants` and `GET /api/sessions` take, so one client
 * builds one query for all three. */
function readOwnerFilter(
  ownerType: string | undefined,
  ownerId: string | undefined,
): { scope?: WorkflowOwnerRef; error?: string } {
  if (ownerType === undefined && ownerId === undefined) return {};
  if (ownerType === undefined || ownerId === undefined) {
    return { error: "Filter by owner with both ownerType and ownerId, or send neither." };
  }
  if (!isWorkflowOwnerType(ownerType)) {
    return { error: "ownerType must be 'user', 'team' or 'org'." };
  }
  return { scope: { ownerType, ownerId } };
}

// ── Definitions ───────────────────────────────────────────────────────────

workflowsRouter.post("/", async (c) => {
  const { deps, owner, env } = serviceCtx(c);

  let body: CreateWorkflowRequest;
  try {
    body = (await c.req.json()) as CreateWorkflowRequest;
  } catch {
    return c.json({ error: "invalid JSON body" }, 400);
  }
  if (!body.name || typeof body.name !== "string") {
    return c.json({ error: "name is required" }, 400);
  }
  if (body.definition === undefined || body.definition === null) {
    return c.json({ error: "definition is required" }, 400);
  }

  const validation = validateDefinitionInput(body.definition, env);
  if (!validation.ok) {
    return c.json({ error: "invalid workflow definition", errors: validation.errors }, 400);
  }

  let created;
  try {
    created = await createWorkflowDefinition(deps, owner, {
      name: body.name,
      definition: body.definition,
      teamId: body.teamId,
    });
  } catch (err) {
    // Same "cross-owner 404, never 403" convention as the rest of this
    // file — a non-member's teamId looks identical to an unknown one.
    if (err instanceof NotFoundError) return c.json({ error: err.message }, 404);
    throw err;
  }
  const resp: CreateWorkflowResponse = created;
  return c.json(resp, 201);
});

/**
 * Without a filter this returns every workflow the caller can reach: their
 * own, plus every team they belong to. `?ownerType=&ownerId=` narrows that
 * to one owner, for a client that shows one workspace at a time.
 */
workflowsRouter.get("/", async (c) => {
  const { deps, owner } = serviceCtx(c);

  const filter = readOwnerFilter(c.req.query("ownerType"), c.req.query("ownerId"));
  if (filter.error) return c.json({ error: filter.error }, 400);
  // The same check `GET /api/workflows/:id` runs, asked of the owner instead
  // of a row, and answered here rather than in the query — an id from a
  // query string never reaches SQL unchecked. 404 because a filter the
  // caller may not use must read exactly like a filter that matches
  // nothing. An `ownerType=org` filter always lands here: no rule admits
  // anybody to an org-owned workflow, so one is no more listable than it is
  // openable.
  if (filter.scope && !(await isAuthorizedForOwner(deps.db, owner, filter.scope))) {
    return c.json({ error: "owner not found" }, 404);
  }

  const resp: ListWorkflowsResponse = {
    workflows: await listWorkflowDefinitions(deps, owner, filter.scope),
  };
  return c.json(resp);
});

// ── Cross-workflow run list ───────────────────────────────────────────────
//
// Registration order is load-bearing: `GET /:id` below also matches the
// single segment `/runs`, and the router picks the route registered first.
// Keep this handler above it. (`GET /runs/:runId` further down is safe at
// any position — two segments never collide with `/:id`.)

workflowsRouter.get("/runs", async (c) => {
  const { deps, owner } = serviceCtx(c);

  const limit = parseRunLimit(c.req.query("limit"));
  if ("error" in limit) return c.json({ error: limit.error }, 400);

  // A whole number, not merely finite: `created_at` is an integer column, and
  // a fractional or out-of-range value reaches the driver as a syntax error.
  const rawSince = blankToUndefined(c.req.query("since"));
  const since = rawSince === undefined ? undefined : Number(rawSince);
  if (since !== undefined && (!Number.isSafeInteger(since) || since < 0)) {
    return c.json({ error: "since must be a whole millisecond timestamp, 0 or greater" }, 400);
  }

  // `status`, `outcome` and `workflowId` are repeatable and match any-of.
  const rawStatus = c.req.queries("status");
  const status = rawStatus?.filter(isRunStatus);
  if (rawStatus && status && status.length !== rawStatus.length) {
    return c.json({ error: `status must be one of: ${RUN_STATUS_VALUES.join(", ")}` }, 400);
  }
  const rawOutcome = c.req.queries("outcome");
  const outcome = rawOutcome?.filter(isRunOutcome);
  if (rawOutcome && outcome && outcome.length !== rawOutcome.length) {
    return c.json({ error: `outcome must be one of: ${RUN_OUTCOME_VALUES.join(", ")}` }, 400);
  }

  let page;
  try {
    page = await listRunsForOwner(deps, owner, {
      workflowIds: c.req.queries("workflowId"),
      status,
      outcome,
      parentRunId: blankToUndefined(c.req.query("parentRunId")),
      since,
      limit: limit.limit,
      cursor: blankToUndefined(c.req.query("cursor")),
    });
  } catch (err) {
    if (err instanceof WorkflowCursorError) return c.json({ error: err.message }, 400);
    throw err;
  }
  // Same convention as every other handler here: a workflow the caller
  // cannot read is indistinguishable from one that does not exist.
  if (!page) return c.json({ error: "workflow not found" }, 404);

  // Rows carry `workflowName`: this list mixes workflows, so the hub's Runs
  // tab has no heading to name them from.
  const resp: ListAllWorkflowRunsResponse = page;
  return c.json(resp);
});

// ── Import ────────────────────────────────────────────────────────────────

/**
 * Reads one file out of a PUBLIC GitHub repository, so the import dialog can
 * take a definition that lives in version control.
 *
 * PUBLIC REPOSITORIES ONLY. The reader accepts a credential (skill sync
 * gives it one), and this route does not pass one yet. That is a gap, not a
 * rule: this route has the caller in `c.var.user`, so the correct credential
 * here is that person's own, through `resolveUserApiToken`, passed as
 * `{ kind: "user", token, ownerScope: "user" }` — the caller reads their own
 * error here, which is what `ownerScope` selects the wording for.
 *
 * Do NOT reach for `services/skill-source-credential.ts` when you close the
 * gap. That module re-checks team and org membership because a source row
 * outlives the membership that justified it; this route is authenticated per
 * request, so the caller's membership is already live. And do NOT resolve
 * the org App installation token, which reaches every repository the App is
 * installed on and would let a caller read a repository they cannot see on
 * GitHub.
 *
 * The file is returned as TEXT. The client owns the one parser that reads
 * both a pasted file and this response, so the two sources cannot drift into
 * accepting different shapes, and the definition is validated where every
 * other definition is validated — `POST /` below, with the full environment
 * hooks that reject an unknown service.
 */
workflowsRouter.get("/import/repo-file", async (c) => {
  const repo = blankToUndefined(c.req.query("repo"));
  const path = blankToUndefined(c.req.query("path"));
  if (repo === undefined) {
    return c.json({ error: "Enter a repository. Write it as owner/repo, or paste its GitHub URL." }, 400);
  }
  if (path === undefined) {
    return c.json(
      { error: "Enter the path of the workflow file in the repository, such as workflows/deploy.json." },
      400,
    );
  }

  // `parseRepoInput` is the address parser the skill sources form already
  // uses. It reads `owner/repo` out of a bare name or a GitHub URL, and it
  // refuses a ref or a path that leaves the repository.
  let parsed;
  try {
    parsed = parseRepoInput(repo, { ref: blankToUndefined(c.req.query("ref")), subpath: path });
  } catch (err) {
    if (err instanceof SkillSourceInputError) return c.json({ error: err.message }, 400);
    throw err;
  }
  if (parsed.subpath === "") {
    return c.json(
      { error: "Enter the path of the workflow file in the repository, such as workflows/deploy.json." },
      400,
    );
  }

  const at = parsed.ref === "" ? "" : ` at ${parsed.ref}`;
  let file: SkillRepoFile | null;
  try {
    // Constructed per request so the GitHub base URL is read now, not at
    // module load — the same rule `repos/github-host.ts` follows.
    file = await new GitHubSkillRepoReader().readFile(parsed.repoFullName, parsed.subpath, parsed.ref);
  } catch (err) {
    // The reader words its own messages for the skill sync sweep, which
    // tells the reader to wait for the next poll. An import has a person in
    // front of it, so the action named here is the one they can take now.
    if (err instanceof SkillRepoTimeoutError) {
      return c.json(
        { error: `GitHub did not answer for ${parsed.repoFullName}. Try the import again.` },
        504,
      );
    }
    if (err instanceof SkillRepoReadError) {
      return c.json(
        {
          error: `GitHub refused to serve ${parsed.repoFullName}/${parsed.subpath}. Valet reads public repositories without a credential, and GitHub limits that to 60 requests each hour. Wait, then try the import again.`,
        },
        502,
      );
    }
    throw err;
  }

  // One message covers every miss: unauthenticated, a private repository, a
  // wrong branch, a misspelled path and a directory all answer the same way.
  if (file === null) {
    return c.json(
      {
        error: `Valet found no file at ${parsed.subpath} in ${parsed.repoFullName}${at}. Valet reads public repositories only, so a private repository, a wrong branch and a misspelled path look the same here. Check the repository, the path and the branch, and make the repository public.`,
      },
      404,
    );
  }
  const content = file.text;
  if (content.trim() === "") {
    return c.json(
      {
        error: `${parsed.subpath} in ${parsed.repoFullName}${at} is empty, or larger than the 1 MB GitHub serves inline. Point the path at the exported definition file.`,
      },
      400,
    );
  }

  const resp: GetWorkflowImportFileResponse = {
    repo: parsed.repoFullName,
    path: parsed.subpath,
    ref: parsed.ref,
    content,
  };
  return c.json(resp);
});

workflowsRouter.get("/:id", async (c) => {
  const { deps, owner } = serviceCtx(c);
  const summary = await getWorkflowDefinition(deps, owner, c.req.param("id"));
  if (!summary) return c.json({ error: "workflow not found" }, 404);
  const resp: GetWorkflowResponse = summary;
  return c.json(resp);
});

workflowsRouter.put("/:id", async (c) => {
  const { deps, owner, env } = serviceCtx(c);
  const id = c.req.param("id");

  let body: UpdateWorkflowRequest;
  try {
    body = (await c.req.json()) as UpdateWorkflowRequest;
  } catch {
    return c.json({ error: "invalid JSON body" }, 400);
  }

  if (body.definition !== undefined) {
    const validation = validateDefinitionInput(body.definition, env);
    if (!validation.ok) {
      return c.json({ error: "invalid workflow definition", errors: validation.errors }, 400);
    }
  }

  const updated = await updateWorkflowDefinition(deps, owner, id, {
    name: body.name,
    definition: body.definition,
  });
  if (!updated) return c.json({ error: "workflow not found" }, 404);

  const resp: UpdateWorkflowResponse = updated;
  return c.json(resp);
});

workflowsRouter.delete("/:id", async (c) => {
  const { deps, owner } = serviceCtx(c);
  const result = await deleteWorkflowDefinition(deps, owner, c.req.param("id"));
  if (result === "not_found") return c.json({ error: "workflow not found" }, 404);
  if (result === "has_active_runs") {
    return c.json(
      { error: "workflow has runs that are not settled. Cancel them first, then delete." },
      409,
    );
  }
  return c.json({ ok: true });
});

// ── Runs ──────────────────────────────────────────────────────────────────
// The owner filter stops at the list above. Every per-workflow route below
// — runs, versions, webhook, schedules — already resolves one workflow id
// and checks its owner, and a workflow has exactly one owner, so an owner
// filter on those could only restate what the path already says.

workflowsRouter.post("/:id/runs", async (c) => {
  const { deps, owner } = serviceCtx(c);
  const id = c.req.param("id");

  let body: StartWorkflowRunRequest = {};
  try {
    const text = await c.req.text();
    if (text.length > 0) body = JSON.parse(text) as StartWorkflowRunRequest;
  } catch {
    return c.json({ error: "invalid JSON body" }, 400);
  }

  const started = await startWorkflowRun(deps, owner, id, body.input);
  if (!started) return c.json({ error: "workflow not found" }, 404);
  if ("invalidInput" in started) {
    return c.json(
      {
        error: `run input is invalid: ${started.invalidInput.map((e) => e.message).join(" ")}`,
        fields: started.invalidInput,
      },
      400,
    );
  }

  const resp: StartWorkflowRunResponse = { runId: started.runId };
  return c.json(resp, 201);
});

workflowsRouter.get("/:id/runs", async (c) => {
  const { deps, owner } = serviceCtx(c);

  const limit = parseRunLimit(c.req.query("limit"));
  if ("error" in limit) return c.json({ error: limit.error }, 400);

  let page;
  try {
    page = await listWorkflowRuns(deps, owner, c.req.param("id"), {
      limit: limit.limit,
      cursor: blankToUndefined(c.req.query("cursor")),
    });
  } catch (err) {
    if (err instanceof WorkflowCursorError) return c.json({ error: err.message }, 400);
    throw err;
  }
  if (!page) return c.json({ error: "workflow not found" }, 404);

  const resp: ListWorkflowRunsResponse = page;
  return c.json(resp);
});

// ── Permissions preview + bulk pre-approval ──────────────────────────────
// The gating set is server-derived from the stored definition on BOTH
// routes; the POST body can only narrow it. See `../workflows/permissions.ts`.

workflowsRouter.get("/:id/permissions", async (c) => {
  const { deps, owner } = serviceCtx(c);
  const nodes = await analyzeWorkflowPermissions(deps, owner, c.req.param("id"));
  if (nodes === null) return c.json({ error: "workflow not found" }, 404);
  const resp: GetWorkflowPermissionsResponse = { nodes };
  return c.json(resp);
});

workflowsRouter.post("/:id/permissions/allow", async (c) => {
  const { deps, owner } = serviceCtx(c);

  // Shape-check before use: `null` would throw on property access below,
  // and a bare array has no own `actionIds`, so it would silently take the
  // "omitted → pre-approve all" branch — a narrowing request must never
  // widen on a permissions-granting route.
  let body: AllowWorkflowPermissionsRequest = {};
  try {
    const text = await c.req.text();
    if (text.length > 0) {
      const parsed: unknown = JSON.parse(text);
      if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
        return c.json(
          { error: 'request body must be a JSON object, e.g. {"actionIds": ["service.action"]}. Omit actionIds to pre-approve all gating actions.' },
          400,
        );
      }
      body = parsed as AllowWorkflowPermissionsRequest;
    }
  } catch {
    return c.json({ error: "invalid JSON body" }, 400);
  }
  if (body.actionIds !== undefined) {
    if (!Array.isArray(body.actionIds) || body.actionIds.some((id) => typeof id !== "string")) {
      return c.json({ error: "actionIds must be an array of strings" }, 400);
    }
  }

  const outcome = await allowWorkflowPermissions(deps, owner, c.req.param("id"), body.actionIds);
  if (outcome === null) return c.json({ error: "workflow not found" }, 404);
  if (!outcome.ok) return c.json({ error: outcome.badRequest }, 400);

  const resp: AllowWorkflowPermissionsResponse = outcome.result;
  return c.json(resp);
});

workflowsRouter.get("/:id/versions", async (c) => {
  const { deps, owner } = serviceCtx(c);
  const versions = await listWorkflowVersions(deps, owner, c.req.param("id"));
  if (!versions) return c.json({ error: "workflow not found" }, 404);
  const resp: ListWorkflowVersionsResponse = { versions };
  return c.json(resp);
});

workflowsRouter.get("/:id/versions/:version", async (c) => {
  const { deps, owner } = serviceCtx(c);
  const version = Number(c.req.param("version"));
  if (!Number.isInteger(version) || version < 1) {
    return c.json({ error: "version must be a positive integer" }, 400);
  }
  const detail = await getWorkflowVersion(deps, owner, c.req.param("id"), version);
  if (!detail) return c.json({ error: "version not found" }, 404);
  const resp: GetWorkflowVersionResponse = detail;
  return c.json(resp);
});

// ── Webhook trigger (overhaul design decision 5) ────────────────────────────
// The bearer secret itself is minted/rotated/revoked here, owner-scoped like
// every other route in this file. The secret is CONSUMED at
// `POST /api/hooks/workflows/:workflowId/:hookId` (`routes/workflow-hooks.ts`),
// an intentionally unauthenticated route mounted before `buildAuthMiddleware`.

workflowsRouter.post("/:id/webhook", async (c) => {
  const { deps, owner } = serviceCtx(c);
  const result = await mintOrRotateWorkflowWebhook(deps.db, owner, c.req.param("id"));
  if (!result.ok) return c.json({ error: result.error }, 404);
  const resp: WorkflowWebhookResponse = {
    ...result.webhook,
    url: workflowWebhookUrl(result.webhook.workflowId, result.webhook.hookId, new URL(c.req.url).origin),
  };
  return c.json(resp);
});

workflowsRouter.get("/:id/webhook", async (c) => {
  const { deps, owner } = serviceCtx(c);
  const result = await getWorkflowWebhook(deps.db, owner, c.req.param("id"));
  if (!result.ok) return c.json({ error: "workflow not found" }, 404);
  if (!result.webhook) return c.json({ error: "no webhook configured for this workflow" }, 404);
  const resp: WorkflowWebhookResponse = {
    ...result.webhook,
    url: workflowWebhookUrl(result.webhook.workflowId, result.webhook.hookId, new URL(c.req.url).origin),
  };
  return c.json(resp);
});

workflowsRouter.delete("/:id/webhook", async (c) => {
  const { deps, owner } = serviceCtx(c);
  const result = await deleteWorkflowWebhook(deps.db, owner, c.req.param("id"));
  if (result === "not_found") return c.json({ error: "workflow not found" }, 404);
  const resp: DeleteWorkflowWebhookResponse = { deleted: result === "deleted" };
  return c.json(resp);
});

// ── Schedules (cron triggers) ─────────────────────────────────────────────
// Owner-scoped like the webhook routes above: every route resolves the
// workflow through `getWorkflowDefinition` first, so an unowned workflow
// 404s identically to a missing one. The schedule service also carries
// orchestrator-prompt schedules; this surface manages only the
// workflow-scoped kind, so every row it returns has a `workflowId`.

function toScheduleWire(s: WorkflowScheduleSummary, workflowId: string): WorkflowScheduleWire {
  return {
    scheduleId: s.scheduleId,
    workflowId: s.workflowId ?? workflowId,
    name: s.name,
    cron: s.cron,
    timezone: s.timezone,
    enabled: s.enabled,
    lastFiredAt: s.lastFiredAt,
    nextFireAt: s.nextFireAt,
  };
}

workflowsRouter.get("/:id/schedules", async (c) => {
  const { deps, owner } = serviceCtx(c);
  const id = c.req.param("id");
  const summary = await getWorkflowDefinition(deps, owner, id);
  if (!summary) return c.json({ error: "workflow not found" }, 404);
  const schedules = await listWorkflowSchedules(deps.db, owner.orgId, id);
  const resp: ListWorkflowSchedulesResponse = {
    schedules: schedules.map((s) => toScheduleWire(s, id)),
  };
  return c.json(resp);
});

workflowsRouter.post("/:id/schedules", async (c) => {
  const { deps, owner } = serviceCtx(c);
  const id = c.req.param("id");
  const summary = await getWorkflowDefinition(deps, owner, id);
  if (!summary) return c.json({ error: "workflow not found" }, 404);

  let body: CreateScheduleOnWorkflowRequest;
  try {
    body = (await c.req.json()) as CreateScheduleOnWorkflowRequest;
  } catch {
    return c.json({ error: "invalid JSON body" }, 400);
  }
  const name = typeof body.name === "string" ? body.name.trim() : "";
  if (!name) {
    return c.json({ error: "name must be a non-empty string" }, 400);
  }
  if (!body.cron || typeof body.cron !== "string") {
    return c.json({ error: "cron must be a 5-field cron expression string" }, 400);
  }
  if (body.timezone !== undefined && typeof body.timezone !== "string") {
    return c.json({ error: "timezone must be an IANA timezone string" }, 400);
  }
  if (
    body.input !== undefined &&
    (typeof body.input !== "object" || body.input === null || Array.isArray(body.input))
  ) {
    return c.json({ error: "input must be a JSON object" }, 400);
  }

  const result = await createWorkflowSchedule(
    deps.db,
    { id: owner.userId, orgId: owner.orgId },
    { workflowId: id, name, cron: body.cron, timezone: body.timezone, input: body.input },
  );
  if (!result.ok) return c.json({ error: result.error }, 400);
  const resp: CreateWorkflowScheduleResponse = toScheduleWire(result.schedule, id);
  return c.json(resp, 201);
});

workflowsRouter.delete("/:id/schedules/:scheduleId", async (c) => {
  const { deps, owner } = serviceCtx(c);
  const id = c.req.param("id");
  const scheduleId = c.req.param("scheduleId");
  const summary = await getWorkflowDefinition(deps, owner, id);
  if (!summary) return c.json({ error: "workflow not found" }, 404);
  const result = await deleteWorkflowSchedule(deps.db, owner.orgId, scheduleId, id);
  if (result === "not_found") return c.json({ error: "schedule not found" }, 404);
  const resp: DeleteWorkflowScheduleResponse = { deleted: true };
  return c.json(resp);
});

workflowsRouter.get("/runs/:runId", async (c) => {
  const { deps, owner } = serviceCtx(c);
  const resp = await getWorkflowRunDetail(deps, owner, c.req.param("runId"));
  if (!resp) return c.json({ error: "run not found" }, 404);
  return c.json(resp);
});

workflowsRouter.post("/runs/:runId/approvals/:nodeId", async (c) => {
  const { deps, owner } = serviceCtx(c);
  const runId = c.req.param("runId");
  const nodeId = c.req.param("nodeId");

  let body: ResolveWorkflowApprovalRequest;
  try {
    body = (await c.req.json()) as ResolveWorkflowApprovalRequest;
  } catch {
    return c.json({ error: "invalid JSON body" }, 400);
  }
  if (typeof body.approved !== "boolean") {
    return c.json({ error: "approved is required" }, 400);
  }
  // Reject legacy grantActions field — scope replaces it.
  if ("grantActions" in body) {
    return c.json({ error: "grantActions is no longer supported; use scope instead" }, 400);
  }
  if (body.scope !== undefined && !["once", "run", "always"].includes(body.scope)) {
    return c.json({ error: "scope must be one of: once, run, always" }, 400);
  }
  if (body.iteration !== undefined && (!Number.isInteger(body.iteration) || body.iteration < 0)) {
    return c.json({ error: "iteration must be a non-negative integer" }, 400);
  }

  const result = await resolveWorkflowApproval(deps, owner, {
    runId,
    nodeId,
    approved: body.approved,
    note: body.note,
    scope: body.scope,
    iteration: body.iteration,
    via: "web",
  });

  if (result === "not_found") return c.json({ error: "run not found" }, 404);
  if (result === "not_parked") return c.json({ error: "run is not parked on this approval gate" }, 409);
  if (result === "already_resolved") return c.json({ error: "this approval gate has already been resolved" }, 409);
  if (result === "timed_out") return c.json({ error: "this approval gate has timed out" }, 409);
  if (result === "forbidden_always") return c.json({ error: "Always allow requires an org admin. Ask an org admin, or approve for the rest of this run." }, 403);
  if (result === "org_mismatch") return c.json({ error: "not a member of this workflow's org" }, 403);
  if (result === "human_only") return c.json({ error: "policy gates must be resolved by a human from the run page" }, 403);

  const resp: ResolveWorkflowApprovalResponse = { ok: true };
  return c.json(resp);
});

workflowsRouter.post("/runs/:runId/cancel", async (c) => {
  const { deps, owner } = serviceCtx(c);
  const runId = c.req.param("runId");

  const result = await cancelWorkflowRun(deps, owner, runId);
  if (result === "not_found") return c.json({ error: "run not found" }, 404);

  const resp: CancelWorkflowRunResponse = { ok: true };
  return c.json(resp);
});

workflowsRouter.post("/runs/:runId/retry", async (c) => {
  const { deps, owner } = serviceCtx(c);
  const runId = c.req.param("runId");

  const result = await retryWorkflowRun(deps, owner, runId);
  if (result === "not_found") return c.json({ error: "run not found" }, 404);
  if (result === "workflow_deleted") {
    return c.json(
      { error: "This run's workflow was deleted. Create the workflow again, then start a new run." },
      404,
    );
  }
  if (result === "not_retryable") {
    return c.json(
      { error: "Only failed or cancelled runs can be retried. Wait for the run to settle, or cancel it first." },
      409,
    );
  }
  if ("invalidInput" in result) {
    // The workflow's trigger schema changed since the original run; mirror
    // the start route's invalid-input shape.
    return c.json(
      {
        error: `The original input no longer matches the workflow's input schema: ${result.invalidInput.map((e) => e.message).join(" ")} Start a new run with valid input.`,
        fields: result.invalidInput,
      },
      400,
    );
  }

  const resp: RetryWorkflowRunResponse = { runId: result.runId };
  return c.json(resp, 201);
});
