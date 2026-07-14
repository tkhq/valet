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
  type Credential,
  type CredentialOwner,
  type CredentialProvider,
  type CredentialStore,
  type PluginAction,
  type PluginActionContext,
  type PluginActionResult,
  type Principal,
  type Sandbox,
  type ValetPlugin,
} from "@valet/engine";
import type { WorkflowInvokeActionRequest, WorkflowInvokeActionResult } from "@valet/workflow";
import type { Static } from "typebox";
import type { AppDb } from "../lib/drizzle.js";
import { actionInvocations } from "../schema/index.js";

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
}

export interface ActionInvokerOpts {
  db: AppDb;
  credentials: CredentialStore;
  actionPluginByService: Map<string, { plugin: ValetPlugin; actionPlugin: ActionPlugin }>;
  clock?: () => number;
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
      .values({ invocationId: req.invocationId, result: JSON.stringify(result), createdAt: clock() })
      .onConflictDoNothing()
      .run();

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
  const row = await db
    .select({ result: actionInvocations.result })
    .from(actionInvocations)
    .where(eq(actionInvocations.invocationId, invocationId))
    .get();
  return row ? parseStoredResult(row.result) : undefined;
}

/** Runtime-validated parse — this is our own serialization, but crossing the JSON boundary still needs a narrowing check rather than a blind cast. */
function parseStoredResult(json: string): WorkflowInvokeActionResult {
  const parsed: unknown = JSON.parse(json);
  if (typeof parsed !== "object" || parsed === null || !("ok" in parsed)) {
    throw new Error(`action-invoker: corrupt stored result: ${json}`);
  }
  const record = parsed as Record<string, unknown>;
  if (record.ok === true) {
    return { ok: true, result: record.result };
  }
  if (record.ok === false && typeof record.error === "string") {
    return { ok: false, error: record.error };
  }
  throw new Error(`action-invoker: corrupt stored result: ${json}`);
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
  const credentials = buildCredentialProvider(opts.credentials, owner, credentialService);

  let action = findAction(entry.actionPlugin.actions, req.service, req.action);
  if (!action && entry.actionPlugin.resolveActions) {
    const resolved = await entry.actionPlugin.resolveActions({ credentials });
    action = findAction(resolved, req.service, req.action);
  }
  if (!action) return unknownAction(req);

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
