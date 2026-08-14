/**
 * Headless ActionInvoker (plugin-system-v2 plan Task 6) — the real
 * implementation behind the workflow `tool` node's `engine.invokeAction`
 * seam. See `@valet/workflow`'s `packages/workflow/src/engine-deps.ts` JSDoc
 * on `WorkflowEngineDeps.invokeAction` for the normative contract this must
 * satisfy: `invocationId` is deterministic (minted once by the tool
 * executor, reused across resumed drives), and a duplicate `invocationId`
 * MUST return the ORIGINAL result rather than re-invoking the action or
 * erroring.
 *
 * Durable dedup: `action_invocations` (invocation_id PK, result JSON text,
 * created_at) records every outcome — including deterministic failures
 * (unknown action, param validation, unsupported owner type) — because
 * those must be just as stable across retries as a success. `INSERT OR
 * IGNORE` (`onConflictDoNothing`) followed by a re-`SELECT` makes two
 * concurrent invocations of the same id converge on whichever row won the
 * insert race, rather than each returning its own freshly-computed result.
 *
 * Runs outside the `list_tools`/`call_tool` catalog flow a live agent turn
 * uses (`@valet/engine`'s `plugin-catalog.ts`) — this invoker calls a
 * resolved `PluginAction.execute` directly, building its own
 * `PluginActionContext` since there is no live session/thread/turn behind a
 * workflow tool-node dispatch.
 */
import { eq } from "drizzle-orm";
import {
  prepareActionArgs,
  type ActionPlugin,
  type ApprovalMode,
  type Credential,
  type CredentialOwner,
  type CredentialProvider,
  type CredentialStore,
  type PluginAction,
  type PluginActionContext,
  type PluginActionResult,
  type Principal,
  type RiskLevel,
  type Sandbox,
  type ValetPlugin,
} from "@valet/engine";
import type { WorkflowInvokeActionRequest, WorkflowInvokeActionResult } from "@valet/workflow";
import type { Static } from "typebox";
import type { AppDb } from "../lib/drizzle.js";
import { actionInvocations } from "../schema/index.js";
import type { GitHubTokenDeps } from "../services/github-tokens.js";
import { resolveSessionGitHubToken } from "../services/session-github-token.js";
import { persistInvocationAudit, resolveActionPolicy } from "../policies/service.js";

/** `PluginActionContext.signal` timeout for a headless invocation — no live turn to bound it otherwise. */
const ACTION_TIMEOUT_MS = 120_000;

/**
 * Resolved run context an `invokeAction` call carries — `userId`/`orgId`
 * are the run's actor bookkeeping fields (same values `resolveRunContext`
 * in `../workflows/engine-deps.ts` produces), `owner` is the run's
 * ownership `Principal`. Kept separate from `WorkflowInvokeActionRequest`
 * (fixed by `@valet/workflow`, carries no owner/org fields) so this module
 * never needs to know the `workflow:{runId}:{nodeId}[:{iteration}]`
 * `invocationId` convention — the caller (`../workflows/engine-deps.ts`)
 * resolves this from the run and passes it in.
 */
export interface ActionInvocationContext {
  userId: string;
  orgId: string;
  owner: Principal;
  /**
   * The REAL app session (`session_repos`) this invocation runs on behalf
   * of, when there is one — distinct from `PluginActionContext.sessionId`
   * (a synthetic `wf:invoke:{invocationId}` id `buildActionContext` mints
   * below, which carries no repo-binding meaning). Today's only production
   * caller (`../workflows/engine-deps.ts`'s `invokeAction`) never sets this
   * — a workflow run has no live sandbox/session behind it — so `github`
   * resolution falls through to the repo-less `auto` tier for every
   * real invocation. The field exists so a future session-bound caller (or
   * a test exercising the repo-bound branch) can opt in.
   */
  sessionId?: string;
  /**
   * The workflow run this invocation belongs to (action-policies plan,
   * Task 3), scoping `appliesIn: "workflow"` policy resolution and any
   * exec-scoped runtime grant that quiets a `require_approval` action. Set by
   * `workflows/engine-deps.ts`'s `invokeAction` (the run id). Absent === no
   * workflow-policy enforcement runs (a direct/test caller with no run
   * context), so the action executes as before.
   */
  workflowExecutionId?: string;
}

export interface ActionInvokerOpts {
  db: AppDb;
  credentials: CredentialStore;
  actionPluginByService: Map<string, { plugin: ValetPlugin; actionPlugin: ActionPlugin }>;
  clock?: () => number;
  /**
   * Deps for resolving `github` service credentials through the canonical
   * token service (`services/github-tokens.ts`'s `resolveGitHubToken`)
   * instead of a raw `CredentialStore` read. Optional — omit when the
   * invoker never dispatches `github` actions; a `github` dispatch without
   * this configured throws a clear wiring error rather than silently
   * mis-resolving.
   */
  githubTokenDeps?: {
    key: Buffer;
    apiUrl?: string;
    githubUrl?: string;
    fetchImpl?: typeof fetch;
    now?: () => number;
  };
}

export type ActionInvoker = (
  req: WorkflowInvokeActionRequest,
  ctx: ActionInvocationContext,
) => Promise<WorkflowInvokeActionResult>;

/**
 * Build the dedup-first action invoker. Returned function is safe to call
 * concurrently with the same `invocationId` — the durable table is the
 * source of truth for "did this already happen," not any in-process cache.
 */
export function buildActionInvoker(opts: ActionInvokerOpts): ActionInvoker {
  const clock = opts.clock ?? Date.now;

  return async (req, ctx) => {
    const existing = await selectStoredResult(opts.db, req.invocationId);
    if (existing) return existing;

    const result = await computeResult(opts, req, ctx);

    await opts.db
      .insert(actionInvocations)
      .values({ invocationId: req.invocationId, result, createdAt: clock() })
      .onConflictDoNothing();

    // Re-select rather than trusting the freshly-computed `result` directly
    // — a concurrent duplicate call may have won the insert race with a
    // different (but equally valid) computed result; both callers must
    // converge on the one row that actually landed.
    const stored = await selectStoredResult(opts.db, req.invocationId);
    if (!stored) {
      throw new Error(`action-invoker: invocation ${req.invocationId} vanished immediately after insert`);
    }
    return stored;
  };
}

async function selectStoredResult(db: AppDb, invocationId: string): Promise<WorkflowInvokeActionResult | undefined> {
  const rows = await db
    .select({ result: actionInvocations.result })
    .from(actionInvocations)
    .where(eq(actionInvocations.invocationId, invocationId))
    .limit(1);
  const row = rows[0];
  return row ? parseStoredResult(row.result) : undefined;
}

/** Runtime-validated narrowing — `result` is a native jsonb value now, but crossing the DB boundary still needs a check rather than a blind cast. */
function parseStoredResult(value: unknown): WorkflowInvokeActionResult {
  if (typeof value !== "object" || value === null || !("ok" in value)) {
    throw new Error(`action-invoker: corrupt stored result: ${JSON.stringify(value)}`);
  }
  const record = value as Record<string, unknown>;
  if (record.ok === true) {
    return { ok: true, result: record.result };
  }
  if (record.ok === false && typeof record.error === "string") {
    return { ok: false, error: record.error };
  }
  throw new Error(`action-invoker: corrupt stored result: ${JSON.stringify(value)}`);
}

async function computeResult(
  opts: ActionInvokerOpts,
  req: WorkflowInvokeActionRequest,
  ctx: ActionInvocationContext,
): Promise<WorkflowInvokeActionResult> {
  const entry = opts.actionPluginByService.get(req.service);
  if (!entry) return unknownAction(req);

  const owner = credentialOwnerFor(ctx.owner);
  if (!owner) {
    return {
      ok: false,
      error: `credential resolution is not supported for owner type "${ctx.owner.type}" (workflow action invocation only supports user/org owners)`,
    };
  }
  const credentialService = entry.actionPlugin.credentialService ?? entry.actionPlugin.service;
  // `github` is the only service that resolves a credential identity today.
  // Any other service would IGNORE the selection, and a node that asked to
  // act as the application would silently act as the workflow owner —
  // exactly the failure `credential` exists to prevent. Refuse instead.
  if (req.credential !== undefined && req.credential !== "auto" && credentialService !== "github") {
    return {
      ok: false,
      error:
        `the ${req.service} service cannot select a "${req.credential}" credential. ` +
        `Remove the credential field from this tool node.`,
    };
  }
  const credentials =
    credentialService === "github"
      ? buildGithubCredentialProvider(opts, req, ctx, owner)
      : buildCredentialProvider(opts.credentials, owner, credentialService);

  // Dynamic `resolveActions` discovery runs BEFORE policy enforcement because
  // resolution needs the action's `riskLevel` (rung 5 fallback) — which only
  // exists once the action is resolved. Discovery may touch credentials (an
  // MCP-proxy plugin lists its tools over an authenticated upstream), but no
  // action is EXECUTED here; enforcement below still gates the actual call.
  let action = findAction(entry.actionPlugin.actions, req.service, req.action);
  if (!action && entry.actionPlugin.resolveActions) {
    const resolved = await entry.actionPlugin.resolveActions({ credentials });
    action = findAction(resolved, req.service, req.action);
  }
  if (!action) return unknownAction(req);

  // Policy enforcement (action-policies plan, Task 3): a workflow tool node
  // runs with no live gate, so `deny` and `require_approval` both fail the
  // node — the latter with instructive text pointing at the two ways to make
  // it pass (an approval node, or a runtime grant). An exec-scoped grant is
  // consulted transparently by `resolveActionPolicy` (grant rung), so a
  // covered action resolves straight to `allow`.
  const denial = await enforceWorkflowPolicy(opts, req, ctx, action.riskLevel, entry.actionPlugin.defaultApprovalMode);
  if (denial) return denial;

  const prepared = prepareActionArgs(action.parameters, req.params);
  if (!prepared.ok) return { ok: false, error: prepared.error };

  const actionCtx = buildActionContext(req, ctx, credentials, action.id);

  let result: PluginActionResult;
  try {
    // `prepared.args` is validated+defaulted against `action.parameters`
    // above, but `PluginAction`'s stored type parameter is erased to the
    // base `TSchema` on the array — same bridge `@valet/engine`'s own
    // `call_tool` executor (`plugin-catalog.ts`) uses for this exact call.
    result = await action.execute(prepared.args as Static<typeof action.parameters>, actionCtx);
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }

  if (!result.success) {
    return { ok: false, error: result.error ?? `${req.service}.${req.action} failed with no error detail` };
  }
  // V2-GAP: attachments dropped — workflow results are JSON-only; revisit
  // once workflow runs have a place to store binary artifacts.
  return { ok: true, result: result.data };
}

function unknownAction(req: WorkflowInvokeActionRequest): WorkflowInvokeActionResult {
  return { ok: false, error: `unknown action: ${req.service}.${req.action}` };
}

/**
 * Resolve + enforce org policy for a workflow tool-node invocation
 * (action-policies plan, Task 3). Returns a failure `WorkflowInvokeActionResult`
 * when the action must NOT run (deny / require_approval with no covering
 * grant), or `null` to proceed. Writes a durable audit row either way
 * (deterministic PK `pol:wf:{invocationId}` → dedups a byte-identical replay).
 * A no-op when the caller supplied no run/org context.
 */
async function enforceWorkflowPolicy(
  opts: ActionInvokerOpts,
  req: WorkflowInvokeActionRequest,
  ctx: ActionInvocationContext,
  riskLevel: RiskLevel,
  pluginDefault: ApprovalMode | undefined,
): Promise<WorkflowInvokeActionResult | null> {
  if (!ctx.orgId || !ctx.workflowExecutionId) return null;
  const now = (opts.clock ?? Date.now)();

  const decision = await resolveActionPolicy(opts.db, {
    orgId: ctx.orgId,
    userId: ctx.userId,
    service: req.service,
    actionId: req.action,
    riskLevel,
    params: req.params,
    appliesIn: "workflow",
    workflowExecutionId: ctx.workflowExecutionId,
    pluginDefault,
    now,
  });

  const allowed = decision.mode === "allow";
  await persistInvocationAudit(opts.db, {
    invocationId: `pol:wf:${req.invocationId}`,
    service: req.service,
    actionId: req.action,
    riskLevel,
    resolvedMode: decision.mode,
    baseMode: decision.provenance.baseMode,
    matchedPolicyId: decision.provenance.matchedPolicyId ?? null,
    matchedGrantId: decision.provenance.matchedGrantId ?? null,
    matchedOverrideId: decision.provenance.matchedOverrideId ?? null,
    status: allowed ? "allowed" : "denied",
    workflowExecutionId: ctx.workflowExecutionId,
    userId: ctx.userId,
    orgId: ctx.orgId,
    params: req.params,
    createdAt: now,
  });

  if (allowed) return null;
  if (decision.mode === "deny") {
    return { ok: false, error: `${req.service}.${req.action} is blocked by org policy` };
  }
  return {
    ok: false,
    error: `${req.service}.${req.action} requires an approval node or a runtime grant`,
  };
}

/** Matches a bare or service-qualified `PluginAction.id` against `(service, action)`, mirroring `@valet/engine`'s `plugin-catalog.ts` fqid convention. */
function findAction(actions: PluginAction[], service: string, actionId: string): PluginAction | undefined {
  return actions.find((a) => {
    if (a.id === actionId) return true;
    const fqid = a.id.includes(".") ? a.id : `${service}.${a.id}`;
    return fqid === `${service}.${actionId}`;
  });
}

/** Decision 15: a workflow run's owner `Principal` maps onto `CredentialOwner` for user/org owners only — team-owned runs have no credential scope today. */
function credentialOwnerFor(owner: Principal): CredentialOwner | null {
  if (owner.type === "user") return { type: "user", id: owner.id };
  if (owner.type === "org") return { type: "org", id: owner.id };
  return null;
}

function buildCredentialProvider(store: CredentialStore, owner: CredentialOwner, defaultService: string): CredentialProvider {
  return {
    async get(service?: string): Promise<Credential | null> {
      const stored = await store.get(owner, service ?? defaultService);
      if (!stored) return null;
      const accessToken = stored.accessToken ?? stored.apiKey ?? "";
      if (accessToken === "") return null;
      return {
        accessToken,
        refreshToken: stored.refreshToken,
        expiresAt: stored.expiresAt,
        scopes: stored.scopes,
        metadata: stored.metadata,
      };
    },
    request(): Promise<Credential> {
      return Promise.reject(new Error("credential requests are not supported in workflow action invocation"));
    },
  };
}

/**
 * `CredentialProvider` for the `github` service — resolves through
 * `resolveSessionGitHubToken`/`resolveGitHubToken` (the canonical GitHub
 * credential path, GitHub/repo integration plan Task 4) instead of a raw
 * `CredentialStore.get` read. `purpose: "api"` matches how the 28
 * plugin-github actions use the resulting token (Octokit API calls, not
 * `git` operations). A `GitHubAuthError` thrown by `resolveGitHubToken` is
 * NOT caught here — it propagates out of `action.execute()` to
 * `computeResult`'s existing try/catch, which maps it to
 * `{ ok: false, error: err.message }` the same way any other thrown error
 * becomes the action's error result (the message already names the gap and
 * carries the connect hint, per `github-tokens.ts`'s doc comment).
 *
 * ── Credential selection (`ToolNode.credential`) ────────────────────────
 * `req.credential` picks the identity the action acts as:
 *
 *   - `"app"`  → `auth: "app"` with the repository taken from the action's
 *     own `owner`/`repo` parameters. `resolveGitHubToken` mints the
 *     installation token for that owner or THROWS. There is no fallback:
 *     an automated review that cannot reach the App must fail visibly
 *     rather than post under the workflow owner's personal account.
 *   - `"user"` → `auth: "user"`, equally strict in the other direction.
 *   - `"auto"` or absent → the pre-existing precedence, binding included.
 *     Every definition written before this field existed lands here.
 */
function buildGithubCredentialProvider(
  opts: ActionInvokerOpts,
  req: WorkflowInvokeActionRequest,
  ctx: ActionInvocationContext,
  owner: CredentialOwner,
): CredentialProvider {
  return {
    async get(service?: string): Promise<Credential | null> {
      // A bare `.get()` or `.get("github")` is the only shape the
      // plugin-github actions use; an explicit different service falls back
      // to a plain store read (byte-identical to non-github services) —
      // no plugin known to this codebase does this today, but the contract
      // shouldn't silently reinterpret an unrelated service as "github".
      if (service !== undefined && service !== "github") {
        return buildCredentialProvider(opts.credentials, owner, service).get(service);
      }
      const tokenDeps = opts.githubTokenDeps;
      if (!tokenDeps) {
        throw new Error("action-invoker: github credential resolution requires githubTokenDeps to be configured");
      }
      const deps: GitHubTokenDeps = {
        db: opts.db,
        credentials: opts.credentials,
        key: tokenDeps.key,
        apiUrl: tokenDeps.apiUrl,
        githubUrl: tokenDeps.githubUrl,
        fetchImpl: tokenDeps.fetchImpl,
        now: tokenDeps.now,
      };
      const selection = req.credential ?? "auto";
      // `params` are template-rendered, so a webhook payload can choose this
      // repo. That is safe only because `mintInstallationToken` looks an
      // installation up by `(orgId, accountLogin)` — the reachable set is
      // the caller's own org. Keep that scoping: a global installation
      // lookup would turn this node into cross-tenant access.
      const repo = selection === "app" ? repoFromParams(req.params) : undefined;
      if (selection === "app" && !repo) {
        throw new Error(
          `${req.service}.${req.action} cannot use the "app" credential: the repository owner is unknown. ` +
            `Add "owner" and "repo" parameters to this tool node.`,
        );
      }
      const resolved = await resolveSessionGitHubToken(deps, {
        orgId: ctx.orgId,
        userId: ctx.userId,
        sessionId: ctx.sessionId,
        purpose: "api",
        // `auto` means "keep the default precedence", so it must NOT
        // override a session binding's own selection.
        ...(selection === "auto" ? {} : { auth: selection }),
        ...(repo ? { repo } : {}),
      });
      // `purpose: "api"` never returns `{ source: "none" }` (it throws
      // instead) — `token` is non-null whenever resolution didn't throw.
      if (resolved.token === null) return null;
      return { accessToken: resolved.token };
    },
    request(): Promise<Credential> {
      return Promise.reject(new Error("credential requests are not supported in workflow action invocation"));
    },
  };
}

/**
 * The repository an `app`-credential invocation resolves its installation
 * against, read from the action's own parameters. Every repo-scoped
 * plugin-github action declares `owner` and `repo` as required strings, so
 * both must be present — `resolveGitHubToken` only reads `owner`, but
 * inventing a `name` for a security decision is worse than refusing.
 */
function repoFromParams(params: Record<string, unknown>): { owner: string; name: string } | undefined {
  const owner = params.owner;
  const name = params.repo;
  if (typeof owner !== "string" || owner.length === 0) return undefined;
  if (typeof name !== "string" || name.length === 0) return undefined;
  return { owner, name };
}

function buildActionContext(
  req: WorkflowInvokeActionRequest,
  ctx: ActionInvocationContext,
  credentials: CredentialProvider,
  actionId: string,
): PluginActionContext {
  const sessionId = `wf:invoke:${req.invocationId}`;
  return {
    userId: ctx.userId,
    orgId: ctx.orgId,
    sessionId,
    threadId: "invoke",
    actionId,
    service: req.service,
    // `WorkflowInvokeActionRequest` carries no summary field (the `tool`
    // node executor's `engine.invokeAction` call never sets one) — left
    // undefined rather than guessing at a value the type doesn't offer.
    summary: undefined,
    credentials,
    sandbox: throwingSandbox(sessionId),
    signal: AbortSignal.timeout(ACTION_TIMEOUT_MS),
    requestDecision: () =>
      Promise.reject(
        new Error("approvals are not available in workflow tool nodes — model the gate as an approval node"),
      ),
    threadRead: () =>
      Promise.reject(new Error("thread history is not available in workflow action invocation")),
    listThreads: () =>
      Promise.reject(new Error("thread listing is not available in workflow action invocation")),
    setModel: () =>
      Promise.reject(new Error("model switching is not available in workflow action invocation")),
  };
}

/** Every method throws — a workflow tool-node action invocation has no sandbox behind it. Implements the full `Sandbox` interface rather than casting an empty object. */
function throwingSandbox(id: string): Sandbox {
  const unavailable = (): never => {
    throw new Error("sandbox unavailable in workflow action invocation");
  };
  return {
    id,
    readFile: () => unavailable(),
    readBinary: () => unavailable(),
    writeFile: () => unavailable(),
    writeBinary: () => unavailable(),
    readdir: () => unavailable(),
    stat: () => unavailable(),
    mkdir: () => unavailable(),
    rm: () => unavailable(),
    exec: () => unavailable(),
  };
}
