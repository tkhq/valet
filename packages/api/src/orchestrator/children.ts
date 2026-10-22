import { intersectToolScopes, readToolScope, TOOL_SCOPE_KEY, UNATTENDED_WORKFLOW_KEY, WORKFLOW_STEP_KEY, type ToolScope } from "@valet/shared";
import { submissionWorkflowStep, type WorkflowStepRef } from "../workflows/step-grants.js";
/**
 * Child spawning + durable settlement watching (Phase 4 decisions 10/11/21).
 *
 * `buildChildSpawner` returns the `ChildSpawner` injected into every
 * orchestrator session's `toolConfig.childSpawner` (see `EngineHost`); it's
 * what the engine's `task` built-in calls. `ChildWatcher` is the
 * restart-survival mechanism for reporting a spawned child's result back to
 * its parent thread as a `child.settled` signal — every unsettled
 * `child_watches` row gets `awaitResult` re-armed on boot
 * (`ChildWatcher.rearm`), and `awaitResult` itself resolves immediately for
 * an already-settled submission, so a re-arm after a crash mid-child-run
 * still delivers exactly one signal (the engine's dispatchId idempotent
 * admission is what actually guarantees "exactly one", not any in-process
 * bookkeeping here — see `arm`'s doc).
 */
import { randomUUID } from "node:crypto";
import { mkdir, rm } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { and, count, eq, isNotNull, isNull, lte, notExists, sql } from "drizzle-orm";
import { governingThreadKeySql, isOutsideReader, outsideReaderMayReach, sharedWithWholeTeamSql, threadSlackChannelsSql } from "../services/thread-access.js";
import {
  namespaceInternalDispatchId,
  PendingCapError,
  recordSandboxDestroyed,
  recordScratchRefused,
  recordScratchRequested,
  ValidationError as EngineValidationError,
  type ChannelOrigin,
  type ChildReader,
  type CompactionEntry,
  type DecisionGate,
  type ChildSender,
  type ChildSpawner,
  type ChildStatusReader,
  type EventStream,
  type EventMatchDigest,
  type Wakeup,
  type NormalizedEvent,
  type Principal,
  type SessionStore,
  type SpawnChildRequest,
  type SpawnChildResult,
  type SubmissionResult,
  walkTranscriptDag,
  type AttachmentState,
} from "@valet/engine";
import { isScratchRequestError, parseResourceQuantity, validateScratchRequest, type ScratchCaps } from "@valet/shared";
import type { AppDb } from "../lib/drizzle.js";
import { agentSessions, childReplyDeliveries, childWatches, eventDropLog, sessionRepos, type ChildWatchRow } from "../schema/index.js";
import type { EngineHost } from "../engine/host.js";
import { loadSessionMeta } from "../engine/session-meta.js";
import { computeTargetDirs } from "../engine/workspace-prep.js";
import type { RepoBinding } from "../wire/types.js";
import type { SourceService } from "../bakes/source-service.js";
import { RegistryCapacityError } from "../bakes/registry-health.js";
import { admitSignal, writeDropLog, SignalEdgeDeniedError } from "./signals.js";
import { revokeSandboxTokens } from "../auth/sandbox-tokens.js";
import { startSweepTimer, type SweepTimer } from "../lib/sweep-timer.js";
import { writeHibernated } from "../engine/hibernation-hooks.js";
import { ingestEvent } from "../events/ingest.js";
import { DEFAULT_ORG_ACTIVE_SESSION_CEILING, MAX_ACTIVE_CHILDREN_PER_ORCHESTRATOR } from "./limits.js";

/** Delay before the in-process retry of a retryable watcher failure (decision 20). */
const DEFAULT_WATCHER_RETRY_DELAY_MS = 30_000;
/** Max in-process attempts for a retryable failure before falling back to the boot `rearm()` backstop. */
const DEFAULT_WATCHER_MAX_ATTEMPTS = 3;
/** Cadence of the parked-sandbox retention sweep. Coarse on purpose — retention windows are hours. */
const DEFAULT_RETENTION_SWEEP_INTERVAL_MS = 15 * 60_000;
/**
 * What `parkChildSandbox` does with a settled child's sandbox in each
 * attachment state. A `provisioning` sandbox is skipped: a forced replace
 * or profile change is building it, and a destroy here would tear it down
 * mid-replace (fix wave 4, concurrency N1).
 */
export type ChildParkAction = "skip" | "record_suspended" | "suspend" | "destroy";

export function childParkAction(state: AttachmentState, retainable: boolean): ChildParkAction {
  if (state === "provisioning") return "skip";
  if (retainable && state === "suspended") return "record_suspended";
  if (retainable && state === "ready") return "suspend";
  return "destroy";
}

export interface ChildrenDeps {
  db: AppDb;
  engineHost: EngineHost;
  engineStore: SessionStore;
  /**
   * Zero-config repo image sources (sandbox-reconcile spec decision 13). A
   * spawn with `req.repo` upserts the repo's image source and touches
   * `last_bound_at`, mirroring the REST session-create route. `ChildWatcher`
   * never uses it.
   */
  prebuildService: SourceService;
  /** Whether children use an isolated sandbox provider. */
  sandboxBacked?: boolean;
  /**
   * Directory under which per-child workspaces are created
   * (`{workspaceRoot}/{childSessionId}`, mkdir'd at spawn). Defaults to
   * `~/.valet/children`; tests point it at a tmp dir.
   */
  workspaceRoot?: string;
  /**
   * Org active-session ceiling, resolved at boot via
   * `resolveOrgSessionCeiling(process.env)` in `buildNodeProviders`.
   * Absent → `DEFAULT_ORG_ACTIVE_SESSION_CEILING`.
   */
  orgSessionCeiling?: number;
  /** Override for `ChildWatcher`'s retryable-failure backoff. Tests only. */
  retryDelayMs?: number;
  /** Override for `ChildWatcher`'s in-process retry budget. Tests only. */
  maxRetryAttempts?: number;
  /**
   * How long a settled child's suspended sandbox is retained before the
   * retention sweep destroys it. Only meaningful on a hibernation-capable
   * backend; `0`/absent keeps the original destroy-on-settle behavior.
   */
  retentionMs?: number;
  /** Override for the retention sweep cadence. Tests only. */
  retentionSweepIntervalMs?: number;
  /** Records a refused `task` scratch request. Tests inject a spy. */
  recordScratchRefused?: (source: string, reason: string) => void;
  /**
   * Deploy and agent caps for a `task`-requested `/scratch` volume
   * (`resolveScratchCaps(process.env)` at real boot). `buildChildSpawner`
   * validates `req.resources.scratch` against these before the child's
   * `agent_sessions` row is ever inserted. The `task` tool renders a
   * refusal as `[task_resources] <message>`, never a partial spawn.
   */
  scratchCaps: ScratchCaps;
}

/** Thrown when a spawn would exceed a decision-21 limit. Message is what the `task` tool surfaces verbatim as error text. */
export class ChildLimitError extends Error {
  readonly code: "child_cap" | "org_ceiling";
  readonly statusCode = 429;
  constructor(code: "child_cap" | "org_ceiling", message: string) {
    super(message);
    this.name = "ChildLimitError";
    this.code = code;
  }
}

function newChildSessionId(): string {
  return `child_${randomUUID()}`;
}

async function cleanupFailedSpawn(
  deps: ChildrenDeps,
  childSessionId: string,
  workspace: string,
  error: unknown,
): Promise<never> {
  await deps.engineStore.deleteWakeupRows((await deps.engineStore.getSession(childSessionId))?.parentSessionId ?? "", {
    wakeupId: `wk_child_events:${childSessionId}`,
  });
  await deps.engineHost.destroy(childSessionId).catch((cleanupError: unknown) => {
    console.error(`buildChildSpawner: failed to destroy partial child ${childSessionId}:`, cleanupError);
  });
  await deps.db.transaction(async (tx) => {
    await tx.delete(childWatches).where(eq(childWatches.childSessionId, childSessionId));
    await tx.delete(sessionRepos).where(eq(sessionRepos.sessionId, childSessionId));
    await tx.delete(agentSessions).where(eq(agentSessions.id, childSessionId));
  });
  await rm(workspace, { recursive: true, force: true });
  throw error;
}

/**
 * Host policy for `SpawnChildRequest.repo` (the `task` tool's free-form repo
 * string). Accepts `owner/repo` shorthand, an `https://host/owner/repo[.git]`
 * URL, or a `git@host:owner/repo[.git]` remote — all normalized to a GitHub
 * https clone URL, matching what the REST create route stores. The shorthand
 * follows GitHub naming: an owner is alphanumeric + hyphen with an
 * alphanumeric first character; a repo also allows dots and underscores
 * (`.github` is legal) but not a leading hyphen. Returns undefined for
 * anything else; exported for direct unit tests.
 */
export function parseTaskRepo(repo: string, branch?: string): RepoBinding | undefined {
  const trimmed = repo.trim();
  const m =
    /^git@[^:/\s]+:([\w.-]+)\/([\w.-]+?)(?:\.git)?$/.exec(trimmed) ??
    /^https?:\/\/[^/\s]+\/([\w.-]+)\/([\w.-]+?)(?:\.git)?\/?$/.exec(trimmed) ??
    /^([A-Za-z0-9][A-Za-z0-9-]*)\/([\w.][\w.-]*)$/.exec(trimmed);
  if (!m) return undefined;
  const fullName = `${m[1]}/${m[2]}`;
  return {
    host: "github",
    fullName,
    cloneUrl: `https://github.com/${fullName}.git`,
    ...(branch !== undefined ? { ref: branch } : {}),
    auth: "auto",
  };
}

/**
 * Enforces decision-21 limits BEFORE anything is created. Throws
 * `ChildLimitError` (and drop-logs) on violation.
 */
async function enforceLimits(
  db: AppDb,
  parentSessionId: string,
  orgId: string,
  orgSessionCeiling: number = DEFAULT_ORG_ACTIVE_SESSION_CEILING,
): Promise<void> {
  const runningChildren = await db
    .select({ childSessionId: childWatches.childSessionId })
    .from(childWatches)
    .where(and(eq(childWatches.parentSessionId, parentSessionId), eq(childWatches.settled, false)));

  if (runningChildren.length >= MAX_ACTIVE_CHILDREN_PER_ORCHESTRATOR) {
    const ids = runningChildren.map((r) => r.childSessionId).join(", ");
    const message = `[child_cap] orchestrator ${parentSessionId} already has ${runningChildren.length} active children (limit ${MAX_ACTIVE_CHILDREN_PER_ORCHESTRATOR}): ${ids}`;
    await writeDropLog(db, {
      orgId,
      reason: "child_cap",
      conversationKey: parentSessionId,
      detail: message,
    });
    throw new ChildLimitError("child_cap", message);
  }

  const [{ n: unsettledChildrenOrgWide }] = await db
    .select({ n: count() })
    .from(childWatches)
    .where(and(eq(childWatches.orgId, orgId), eq(childWatches.settled, false)));
  // Child sessions are counted through their watch rows above — a running
  // child once (unsettled watch), a settled child zero. Their agent_sessions
  // rows outlive settlement, so counting them here would double-count every
  // running child and hold a settled child's slot forever.
  //
  // Only `active` rows count. A `hibernated` session is parked (the idle
  // sweep suspended its sandbox) and an `archived` session is shelved by the
  // user — neither consumes compute, so neither may consume capacity. The
  // old `!= deleted` filter made the ceiling a lifetime session counter:
  // every org eventually hit it through accumulation alone.
  const [{ n: liveSessionsOrgWide }] = await db
    .select({ n: count() })
    .from(agentSessions)
    .where(
      and(
        eq(agentSessions.orgId, orgId),
        eq(agentSessions.status, "active"),
        notExists(
          db
            .select({ one: sql`1` })
            .from(childWatches)
            .where(
              and(eq(childWatches.orgId, orgId), eq(childWatches.childSessionId, agentSessions.id)),
            ),
        ),
      ),
    );
  const total = Number(unsettledChildrenOrgWide ?? 0) + Number(liveSessionsOrgWide ?? 0);
  if (total >= orgSessionCeiling) {
    const message = `[org_ceiling] org ${orgId} is at ${total} active sessions (unsettled children + active sessions), limit ${orgSessionCeiling}. Archive or delete idle sessions, or raise VALET_ORG_SESSION_CEILING.`;
    await writeDropLog(db, { orgId, reason: "org_ceiling", conversationKey: parentSessionId, detail: message });
    throw new ChildLimitError("org_ceiling", message);
  }
}

/** The unsettled watch for a child session: its parent thread and the
 * channel conversation that started the work. Undefined for any session that
 * is not an unsettled child. */
export async function activeChildWatch(db: AppDb, childSessionId: string): Promise<ArmArgs | undefined> {
  const [row] = await db.select().from(childWatches)
    .where(and(eq(childWatches.childSessionId, childSessionId), eq(childWatches.settled, false))).limit(1);
  return row ? watchRowToArgs(row) : undefined;
}

function watchRowToArgs(row: ChildWatchRow): ArmArgs {
  return {
    childSessionId: row.childSessionId,
    queueItemId: row.queueItemId,
    parentSessionId: row.parentSessionId,
    parentThreadId: row.parentThreadId,
    actorUserId: row.actorUserId,
    orgId: row.orgId,
    origin: parseOriginJson(row.originJson),
  };
}

/** Parses a watch row's stored ChannelOrigin. Null/garbage → undefined —
 * an unreadable origin degrades to the pre-origin behavior, never a throw. */
function parseOriginJson(raw: string | null): ChannelOrigin | undefined {
  if (!raw) return undefined;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (parsed !== null && typeof parsed === "object" && typeof (parsed as ChannelOrigin).threadKey === "string") {
      return parsed as ChannelOrigin;
    }
  } catch {
    // fall through
  }
  return undefined;
}

/** The reply intent id of one child submission's settlement: the namespaced dispatch id. */
function settledReplyId(childSessionId: string, childItemId: string): string {
  return namespaceInternalDispatchId(childSessionId, `settled:${childSessionId}:${childItemId}`);
}

/**
 * Submission metadata that marks child work the parent delegated, by spawn
 * or `child_send`. The engine stores it at admission and copies it when a
 * queued item is promoted, so moved delegated work keeps it. Reply route
 * decisions read this, not `author`: a `child_send` submission also names
 * the steering member as its author.
 */
export const PARENT_DELEGATION_METADATA_KEY = "parentDelegation";

/**
 * `replyThreadKey` names the channel thread of the sending turn, only when
 * that turn replies there automatically. A web turn has none.
 */
export function parentDelegationMetadata(
  parentSessionId: string,
  parentThreadId: string,
  origin?: ChannelOrigin,
): Record<string, unknown> {
  const replyThreadKey = origin !== undefined && origin.reply !== "manual" ? origin.threadKey : undefined;
  return { [PARENT_DELEGATION_METADATA_KEY]: { parentSessionId, parentThreadId, ...(replyThreadKey ? { replyThreadKey } : {}) } };
}

/** True when the submission is work the parent delegated, not input from a person. */
export function isParentDelegation(item: { metadata?: Record<string, unknown> } | null | undefined): boolean {
  const provenance = item?.metadata?.[PARENT_DELEGATION_METADATA_KEY];
  return provenance !== null && typeof provenance === "object";
}

/** Where delegated work came from: the parent thread, and the sending turn's automatic channel thread. */
function delegationSource(item: { metadata?: Record<string, unknown> } | null | undefined): DelegationSource {
  const provenance = item?.metadata?.[PARENT_DELEGATION_METADATA_KEY];
  if (provenance === null || typeof provenance !== "object") return {};
  const field = (name: string) => {
    const value: unknown = name in provenance ? (provenance as Record<string, unknown>)[name] : undefined;
    return typeof value === "string" ? value : undefined;
  };
  return { parentThreadId: field("parentThreadId"), replyThreadKey: field("replyThreadKey") };
}

type DelegationSource = { parentThreadId?: string; replyThreadKey?: string };

/**
 * Reply-route state of a child watch (`child_watches.reply_route`). The
 * stored origin never changes, because it also decides transcript sharing.
 * `origin` follows the origin's own reply policy, `manual` allows only
 * explicit replies, and `none` sends the settlement with no origin. Only the
 * spawner writes `origin`. Null marks a row written before this column: its
 * takeover or cross-thread history is unknown, so it reads as `manual`.
 */
export type ChildReplyRoute = "origin" | "manual" | "none";

/** The origin a settlement carries: the stored origin with its reply-route state applied. */
function settlementOrigin(originJson: string | null, replyRoute: string | null): ChannelOrigin | undefined {
  const origin = parseOriginJson(originJson);
  if (origin === undefined || replyRoute === "none") return undefined;
  return replyRoute === "origin" ? origin : { ...origin, reply: "manual" };
}

/**
 * True when input that the automatic route does not cover is in the child's
 * transcript before `itemId`'s own entries. That is input from a person (a
 * prompt while the child was idle, a followup, or a steer), or parent work
 * that would not keep the route (`nextReplyRoute`), such as work from a
 * private parent thread. A signal from another session does not count.
 * The transcript is the execution order: a run writes its submission there.
 * A followup that later work replaced before it started never reached it.
 * Queue `createdAt` is not the execution order, because a promotion takes
 * a timestamp ahead of the queued items. The check reads durable entries
 * and queue items, so it covers every way input can reach the child,
 * including parent work whose sender failed to store its route.
 */
async function privateInputBefore(
  store: SessionStore,
  childSessionId: string,
  itemId: string,
  watch: { parentThreadId: string; originThreadKey?: string },
): Promise<boolean> {
  const item = await store.getQueueItem(childSessionId, itemId);
  if (!item) return false;
  const ranBefore = new Set<string>();
  for (const entry of await store.getEntries(childSessionId, item.threadId)) {
    if (entry.queueItemId === item.id) break;
    if (entry.queueItemId !== undefined) ranBefore.add(entry.queueItemId);
  }
  if (ranBefore.size === 0) return false;
  const keepsRoute = (other: { metadata?: Record<string, unknown> }) => isParentDelegation(other)
    && nextReplyRoute("origin", { delegated: true, ...delegationSource(other) }, watch) === "origin";
  return [
    ...(await store.listUnsettledSubmissions(childSessionId)),
    ...(await store.listSettledSubmissionsBefore(childSessionId, Number.MAX_SAFE_INTEGER)),
  ].some((other) => ranBefore.has(other.id) && !keepsRoute(other) && !isSignalSubmission(other));
}

function isSignalSubmission(item: { content: unknown }): boolean {
  const content = item.content;
  return content !== null && typeof content === "object" && "kind" in content && content.kind === "signal";
}

/**
 * The reply route after the watch moves to new child work. Work a person
 * started (no parent delegation provenance) has no route. Parent work after
 * a takeover gets a manual route back: the person's input is in the child's
 * transcript, so the parent may answer the channel thread but never posts
 * there automatically. An automatic route stays only for parent work sent
 * by a channel turn on the delegating parent thread that replies to the
 * same channel thread. Work from another parent thread, or from a web turn
 * on the same thread, can carry private context, so it downgrades to manual.
 */
export function nextReplyRoute(
  current: string | null,
  work: { delegated: boolean } & DelegationSource,
  watch: { parentThreadId: string; originThreadKey?: string },
): string | null {
  if (!work.delegated) return "none";
  if (current === "none") return "manual";
  if (current === "origin" && (work.parentThreadId !== watch.parentThreadId
    || work.replyThreadKey === undefined || work.replyThreadKey !== watch.originThreadKey)) return "manual";
  return current;
}

/** The prompt options of a parent `child_send`. Tests use them to model the real sender. */
export function childSendPromptOptions(
  ctx: { parentSessionId: string; parentThreadId: string; actorUserId: string; origin?: ChannelOrigin; toolScope?: ToolScope; unattendedWorkflow?: boolean; workflowStep?: WorkflowStepRef },
  queue: boolean,
): { author: { id: string; name: string }; queueMode: "followup" | "steer"; metadata: Record<string, unknown> } {
  return {
    // The agent writes the text, but the steering member supplies its
    // authority. Persist that actor on the submission instead of inheriting
    // the spawner.
    author: { id: ctx.actorUserId, name: "Valet" },
    queueMode: queue ? "followup" : "steer",
    metadata: { ...parentDelegationMetadata(ctx.parentSessionId, ctx.parentThreadId, ctx.origin), ...(ctx.toolScope ? { toolScope: ctx.toolScope } : {}),
      ...(ctx.unattendedWorkflow ? { [UNATTENDED_WORKFLOW_KEY]: true } : {}),
      ...(ctx.unattendedWorkflow && ctx.workflowStep ? { [WORKFLOW_STEP_KEY]: ctx.workflowStep } : {}) },
  };
}

/** A spawned child of an unattended workflow task: it refuses decisions, and
 * it works in the parent submission's workflow step. */
async function unattendedChildMetadata(
  engineStore: ChildrenDeps["engineStore"],
  ctx: { parentSessionId: string; parentQueueItemId?: string },
): Promise<Record<string, unknown>> {
  const step = await submissionWorkflowStep(engineStore, ctx.parentSessionId, ctx.parentQueueItemId);
  return { [UNATTENDED_WORKFLOW_KEY]: true, ...(step ? { [WORKFLOW_STEP_KEY]: step } : {}) };
}

/**
 * Builds the `ChildSpawner` handed to orchestrator sessions via
 * `toolConfig.childSpawner`. `watcher.arm` is called (never awaited) once
 * the `child_watches` row is durably inserted — decision 11's "insert
 * before returning" contract; the actual settlement wait/report happens
 * off this call stack (decision 10: `task` is fire-and-forget).
 */
export function buildChildSpawner(deps: ChildrenDeps, watcher: ChildWatcher): ChildSpawner {
  return async (
    req: SpawnChildRequest,
    ctx: {
      parentSessionId: string;
      parentThreadId: string;
      actorUserId: string;
      owner: Principal;
      origin?: ChannelOrigin;
      unattendedWorkflow?: boolean;
      parentQueueItemId?: string;
    },
  ): Promise<SpawnChildResult> => {
    const parentData = await deps.engineStore.getSession(ctx.parentSessionId);
    if (!parentData) {
      throw new Error(`buildChildSpawner: parent session not found: ${ctx.parentSessionId}`);
    }
    const orgId = parentData.orgId;
    // The parent's thread focus stays with the parent; `req.toolScope` already carries its ceiling.
    const toolScope = intersectToolScopes(readToolScope(parentData.metadata?.[TOOL_SCOPE_KEY]), req.toolScope);

    // Host policy for `req.repo` (`task` tool): normalize before anything is
    // created so a bad value costs nothing. The message is what the tool
    // surfaces verbatim.
    const binding = req.repo !== undefined ? parseTaskRepo(req.repo, req.branch) : undefined;
    if (req.repo !== undefined && binding === undefined) {
      throw new Error(
        `unrecognized repo '${req.repo}'. Pass owner/repo or a GitHub clone URL.`,
      );
    }

    // Same "validate before anything is created" rule as `req.repo` above.
    // A `ScratchRequestError` here (refused, never clamped) must throw
    // BEFORE the `agent_sessions` insert, so a bad request never leaves a
    // partial child behind. The `task` tool renders the thrown message
    // verbatim as `[task_resources] <message>`.
    if (req.resources?.scratch !== undefined) {
      let scratch: string;
      try {
        scratch = validateScratchRequest(req.resources.scratch, "task", deps.scratchCaps);
      } catch (err) {
        // Counted like the prebuild source (fix wave 3, data L5).
        if (isScratchRequestError(err)) (deps.recordScratchRefused ?? recordScratchRefused)("task", err.reason);
        throw err;
      }
      req = { ...req, resources: { ...req.resources, scratch } };
      recordScratchRequested("task", parseResourceQuantity(scratch) ?? 0);
    }

    await enforceLimits(deps.db, ctx.parentSessionId, orgId, deps.orgSessionCeiling);
    const warnings: string[] = [];
    if (deps.sandboxBacked ?? deps.prebuildService.builderBackend === "kubernetes") {
      try {
        await deps.prebuildService.assertRegistryCapacity();
      } catch (error) {
        if (!(error instanceof RegistryCapacityError)) throw error;
        const image = await deps.engineHost.resolveChildStartupImage({
          userId: ctx.actorUserId, orgId, workspace: "", profile: req.profile, docker: req.docker,
          repos: binding ? [{ ...binding, targetDir: computeTargetDirs([binding])[0] ?? "" }] : [],
        });
        if (!image) throw error;
        const warning = `Starting sandbox with existing image ${image}. ${error.message.replace("Sandbox image can't be built:", "New image bakes are blocked:")}`;
        warnings.push(warning);
        console.warn("sandbox_registry_warning", { orgId, warning });
      }
    }


    // A pre-assigned id (the security dispatch's cell-claim seam) wins so
    // the caller's durable claim row names the session this spawn builds.
    const childSessionId = req.sessionId ?? newChildSessionId();
    const workspace = join(deps.workspaceRoot ?? join(homedir(), ".valet", "children"), childSessionId);

    // A child resolves credentials the way its parent does. A team
    // orchestrator from before owner-mode resolution keeps acting as the
    // member (team credentials design, deviation 13); its delegated tasks
    // must not switch identity mid-conversation. A parent with no row, or
    // one in owner mode, spawns an owner-mode child.
    const parentRows = await deps.db
      .select({ credentialOwnerMode: agentSessions.credentialOwnerMode })
      .from(agentSessions)
      .where(eq(agentSessions.id, ctx.parentSessionId))
      .limit(1);
    const credentialOwnerMode = parentRows[0]?.credentialOwnerMode === "actor" ? "actor" : "owner";

    if (req.sessionId) {
      const [existingRows, existingRepos, existingWatches, existingEngine] = await Promise.all([
        deps.db.select().from(agentSessions).where(eq(agentSessions.id, childSessionId)).limit(1),
        deps.db.select().from(sessionRepos).where(eq(sessionRepos.sessionId, childSessionId)),
        deps.db.select().from(childWatches).where(eq(childWatches.childSessionId, childSessionId)).limit(1),
        deps.engineStore.getSession(childSessionId),
      ]);
      if (existingRows.length || existingRepos.length || existingWatches.length || existingEngine) {
        throw new Error(`child session id ${childSessionId} already belongs to an existing session`);
      }
    }

    // Commit the authoritative shape and repo binding together before the
    // build. Capability persistence and SpecProvider both read these rows.
    const now = Date.now();
    await mkdir(workspace, { recursive: true });
    try {
      await deps.db.transaction(async (tx) => {
        await tx.insert(agentSessions).values({
          id: childSessionId,
          userId: ctx.actorUserId,
          orgId,
          workspace,
          title: req.title ?? null,
          profile: req.profile ?? "headless",
          docker: req.docker === true,
          kubernetes: false,
          sandboxResourceOverrides: req.resources ?? null,
          status: "active",
          ownerType: ctx.owner.type,
          ownerId: ctx.owner.id,
          credentialOwnerMode,
          createdAt: now,
          updatedAt: now,
          lastActivityAt: now,
        });
        if (binding) {
          await tx.insert(sessionRepos).values({
            sessionId: childSessionId,
            host: binding.host ?? "github",
            fullName: binding.fullName,
            cloneUrl: binding.cloneUrl,
            ref: binding.ref ?? null,
            auth: binding.auth ?? "auto",
            position: 0,
            targetDir: computeTargetDirs([binding])[0] ?? null,
          });
        }
      });
    } catch (error) {
      await rm(workspace, { recursive: true, force: true });
      throw error;
    }

    if (binding) {
      // Zero-config generation (spec decision 13), same fire-and-forget as
      // the REST create route — `ensureRepoSource` never throws.
      void deps.prebuildService.ensureRepoSource(orgId, {
        host: binding.host ?? "github",
        fullName: binding.fullName,
        cloneUrl: binding.cloneUrl,
      });
    }

    // Read before the child exists, so a failed read leaves nothing to clean up.
    const unattendedMetadata = ctx.unattendedWorkflow ? await unattendedChildMetadata(deps.engineStore, ctx) : {};
    const childSession = await deps.engineHost.childSessionFor(childSessionId, {
      credentialOwnerMode,
      parentSessionId: ctx.parentSessionId,
      parentThreadId: ctx.parentThreadId,
      actorUserId: ctx.actorUserId,
      orgId,
      owner: ctx.owner,
      workspace,
      modelId: req.model,
      toolScope,
      profile: req.profile,
      docker: req.docker,
      resources: req.resources,
      startupWarnings: warnings,
      sharedTranscript: ctx.origin !== undefined,
    }).catch((error: unknown) => cleanupFailedSpawn(deps, childSessionId, workspace, error));

    // No `author`: the parent AGENT composed this prompt, and `author`
    // means "the person who wrote this" — it renders as a `[from: …]` line
    // in shared-session transcripts and as a named sender in the UI, both
    // wrong for agent text. Actor linkage stays on the child_watches row
    // (`actorUserId` below).
    await watcher.ensureSubscription({ childSessionId, parentSessionId: ctx.parentSessionId, parentThreadId: ctx.parentThreadId })
      .catch((error: unknown) => cleanupFailedSpawn(deps, childSessionId, workspace, error));

    const receipt = await childSession.prompt(req.prompt, {
      // Per-turn role overlay (the security dispatch names the persona
      // role; the claimed child's build registered it in options.roles).
      ...(req.role !== undefined ? { role: req.role } : {}),
      // A child of an unattended workflow task refuses decisions too, and
      // works in the parent's workflow step.
      metadata: { ...parentDelegationMetadata(ctx.parentSessionId, ctx.parentThreadId, ctx.origin),
        ...unattendedMetadata },
    }).catch((error: unknown) => cleanupFailedSpawn(deps, childSessionId, workspace, error));

    await deps.db
      .insert(childWatches)
      .values({
        childSessionId,
        queueItemId: receipt.queueItemId,
        parentSessionId: ctx.parentSessionId,
        parentThreadId: ctx.parentThreadId,
        actorUserId: ctx.actorUserId,
        orgId,
        settled: false,
        createdAt: now,
        // Durable: the settlement can arrive after a restart (rearm), and
        // the child.settled signal must still inherit this origin.
        originJson: ctx.origin !== undefined ? JSON.stringify(ctx.origin) : null,
        replyRoute: ctx.origin !== undefined ? ("origin" satisfies ChildReplyRoute) : null,
      })
      .catch((error: unknown) => cleanupFailedSpawn(deps, childSessionId, workspace, error));

    watcher.arm({
      childSessionId,
      queueItemId: receipt.queueItemId,
      parentSessionId: ctx.parentSessionId,
      parentThreadId: ctx.parentThreadId,
      actorUserId: ctx.actorUserId,
      orgId,
      origin: ctx.origin,
    });

    return { childSessionId, queueItemId: receipt.queueItemId, ...(warnings.length ? { warnings } : {}) };
  };
}

export interface ArmArgs {
  childSessionId: string;
  queueItemId: string;
  /** A later signal turn within the same delegation. The watch keeps its steering generation. */
  resultItemId?: string;
  parentSessionId: string;
  parentThreadId: string;
  actorUserId: string;
  orgId: string;
  /** The spawning submission's channel origin, inherited by child.settled. */
  origin?: ChannelOrigin;
}

/**
 * Classification of a failure raised by `ChildWatcher.attempt` (decision
 * 20). Exported and pure so the boundary can be unit-tested directly instead
 * of by forcing specific exceptions through the full watcher/db plumbing
 * (see CLAUDE.md "extract pure functions to avoid testing private members").
 *
 * - `retryable`: a transient condition (the parent thread's pending cap,
 *   `PendingCapError`; or anything else that isn't a recognized permanent
 *   denial, e.g. the parent/child session not existing *yet*). The watch
 *   must NOT be marked settled — the signal is still owed. `pendingCap`
 *   marks the `PendingCapError` case specifically, since it gets its own
 *   drop-log reason.
 * - `permanent`: a denial that will never succeed no matter how many times
 *   it's retried — `SignalEdgeDeniedError` (real edge-ACL denial) or an
 *   engine `ValidationError` (e.g. hop budget exceeded). `alreadyLogged`
 *   is true when `admitSignal`/`authorizeEdge` already wrote the
 *   corresponding drop-log row with the correct reason (edge_denied /
 *   hop_budget) — the caller must not write a second one.
 */
export type WatcherErrorClassification =
  | { kind: "retryable"; pendingCap: boolean }
  | { kind: "permanent"; alreadyLogged: boolean };

export function classifyWatcherError(err: unknown): WatcherErrorClassification {
  if (err instanceof SignalEdgeDeniedError) {
    // Always self-logged with reason 'edge_denied' inside `authorizeEdge`.
    return { kind: "permanent", alreadyLogged: true };
  }
  if (err instanceof EngineValidationError) {
    // The hop-budget case is self-logged with reason 'hop_budget' inside
    // `admitSignal`'s catch. Any other ValidationError-shaped denial (none
    // reachable from this path today, but the engine may add one) is still
    // a permanent, non-retryable failure — it just needs its own drop-log
    // row here, using the closest available reason.
    return { kind: "permanent", alreadyLogged: /hop budget/i.test(err.message) };
  }
  // PendingCapError (transient — the cap frees up once the parent thread
  // drains) and every other failure (e.g. a session not yet visible) are
  // treated as retryable: the row must stay unsettled so the signal isn't
  // permanently lost, and `rearm()` at the next boot is the durable
  // backstop once in-process retries are exhausted.
  return { kind: "retryable", pendingCap: err instanceof PendingCapError };
}

/**
 * Publishes normalized child events and recovers their subscriptions at boot.
 * WakeWatcher owns buffered delivery. Queue dispatch ids make retries idempotent.
 * Notification acknowledgement and sandbox reclaim have separate guards.
 */
export class ChildWatcher {
  private readonly retryDelayMs: number;
  private readonly maxAttempts: number;
  private retentionTimer: SweepTimer | undefined;
  /** Children the retention sweep already logged as kept by background work. */
  private readonly keptForWork = new Set<string>();

  constructor(private readonly deps: ChildrenDeps) {
    this.retryDelayMs = deps.retryDelayMs ?? DEFAULT_WATCHER_RETRY_DELAY_MS;
    this.maxAttempts = deps.maxRetryAttempts ?? DEFAULT_WATCHER_MAX_ATTEMPTS;
  }

  /** Publishes a gate event. Delivery keeps gate replies manual. */
  async reportGateOpened(childSessionId: string, gate: Pick<DecisionGate, "id" | "title" | "type" | "queueItemId" | "threadId">): Promise<void> {
    const [row] = await this.deps.db.select().from(childWatches).where(eq(childWatches.childSessionId, childSessionId)).limit(1);
    if (!row) return;
    const watch = watchRowToArgs(row);
    await this.ensureSubscription(watch);
    await this.publish(watch, {
      key: "child.gate_opened",
      dedupeKey: `gate-opened:${childSessionId}:${gate.id}`,
      occurredAt: new Date().toISOString(),
      subjects: [`valet:session:${childSessionId}`],
      refs: { child_session_id: childSessionId, child_queue_item_id: watch.queueItemId, gate_id: gate.id },
      summary: `Child ${childSessionId} is paused on a ${gate.type} request: "${gate.title}".`,
      payload: { gate },
    });
  }

  private async deliverGate(watch: ArmArgs, gate: Pick<DecisionGate, "id" | "title" | "type" | "queueItemId" | "threadId">): Promise<void> {
    const childSessionId = watch.childSessionId;
    const childData = await this.deps.engineStore.getSession(childSessionId);
    if (!childData) return;
    const [submission, thread] = await Promise.all([
      this.deps.engineStore.getQueueItem(childSessionId, gate.queueItemId),
      this.deps.engineStore.getThread(childSessionId, gate.threadId),
    ]);
    const toolScope = submission && thread
      ? intersectToolScopes(readToolScope(childData.metadata?.[TOOL_SCOPE_KEY]), readToolScope(submission.metadata?.[TOOL_SCOPE_KEY]), readToolScope(thread.metadata?.[TOOL_SCOPE_KEY]))
      : { tools: [], actions: [] };
    await admitSignal(this.deps, {
      from: { sessionId: childSessionId, owner: childData.owner },
      to: watch.parentSessionId,
      threadKey: watch.parentThreadId,
      content: {
        kind: "signal",
        signalType: "child.gate_opened",
        body:
          `Child ${childSessionId} is paused on a ${gate.type} request: "${gate.title}". ` +
          "The request was sent to the person who can answer it. The child resumes when it is answered. " +
          "Do not answer it for them; mention it only if the person is waiting on this work.",
        attributes: { child_session_id: childSessionId, gate_id: gate.id, gate_type: gate.type },
        ...(watch.origin !== undefined ? { origin: { ...watch.origin, reply: "manual" } } : {}),
      },
      toolScope,
      dispatchId: `gate-opened:${childSessionId}:${gate.id}`,
    });
  }

  /** Fire-and-forget: arms `awaitResult` for one watch row. `attempt` is 1-based, reset to 1 on every `arm`/`rearm` call. */
  arm(watch: ArmArgs, attempt = 1): void {
    void this.run(watch, attempt).catch((err) => {
      console.error(`ChildWatcher: unexpected error watching ${watch.childSessionId}:`, err);
    });
  }

  private async run(watch: ArmArgs, attempt: number): Promise<void> {
    try {
      await this.ensureSubscription(watch);
      await this.attempt(watch);
    } catch (err) {
      const classification = classifyWatcherError(err);

      if (classification.kind === "retryable") {
        if (classification.pendingCap) {
          // Every failed cap-hit is itself a rejected admission — record it,
          // even though we'll retry, so the cap enforcement is visible in
          // the drop log (decision 20's "policy drops are never invisible").
          await writeDropLog(this.deps.db, {
            orgId: watch.orgId,
            reason: "pending_cap",
            conversationKey: watch.queueItemId,
            detail: `child watcher deferred reporting settlement of ${watch.childSessionId} on parent thread ${watch.parentThreadId}: pending cap reached (attempt ${attempt}): ${String(err)}`,
          });
        }
        if (attempt >= this.maxAttempts) {
          console.error(
            `ChildWatcher: ${watch.childSessionId} still retryable after ${attempt} in-process attempts; leaving unsettled for the next boot's rearm():`,
            err,
          );
          return;
        }
        console.error(
          `ChildWatcher: attempt ${attempt} failed for ${watch.childSessionId} (retryable), retrying in ${this.retryDelayMs}ms:`,
          err,
        );
        const timer = setTimeout(() => this.arm(watch, attempt + 1), this.retryDelayMs);
        timer.unref();
        return;
      }

      // Permanent denial. Don't double-log what `admitSignal`/`authorizeEdge`
      // already recorded with the correct reason.
      if (!classification.alreadyLogged) {
        await writeDropLog(this.deps.db, {
          orgId: watch.orgId,
          reason: "edge_denied",
          conversationKey: watch.queueItemId,
          detail: `child watcher permanently failed to report settlement of ${watch.childSessionId} (not an edge denial — ${err instanceof Error ? err.name : "error"}): ${String(err)}`,
        });
      }
      console.error(`ChildWatcher: giving up on ${watch.childSessionId} after permanent failure:`, err);
      await this.deps.db.update(childReplyDeliveries).set({ failedAt: Date.now(), lastError: String(err).slice(0, 1_000) })
        .where(and(eq(childReplyDeliveries.id, namespaceInternalDispatchId(watch.childSessionId, `settled:${watch.childSessionId}:${watch.queueItemId}`)),
          eq(childReplyDeliveries.orgId, watch.orgId), isNull(childReplyDeliveries.queueItemId)));
      await this.markSettled(watch.childSessionId, watch.queueItemId);
      // No sandbox teardown here, deliberately: a permanent denial means
      // the parent never received the settlement, so keep the sandbox and
      // cached session around for debugging. The idle sweep owns the
      // eventual reclaim. Only the delivered-settlement path (attempt)
      // tears down eagerly.
    }
  }

  private async attempt(watch: ArmArgs, digest?: EventMatchDigest): Promise<void> {
    const itemId = watch.resultItemId ?? watch.queueItemId;
    const childData = await this.deps.engineStore.getSession(watch.childSessionId);
    if (!childData) throw new Error(`child session not found: ${watch.childSessionId}`);

    // Centralized meta assembly (repo bindings + git identity). The app row
    // supplies the persisted profile, Docker flag, and resource overrides.
    // If this watcher wins the post-restart first-touch race, the rebuild
    // must keep the child's full sandbox shape.
    const shapeRows = await this.deps.db
      .select({
        profile: agentSessions.profile,
        docker: agentSessions.docker,
        kubernetes: agentSessions.kubernetes,
        sandboxResourceOverrides: agentSessions.sandboxResourceOverrides,
        credentialOwnerMode: agentSessions.credentialOwnerMode,
      })
      .from(agentSessions)
      .where(eq(agentSessions.id, watch.childSessionId))
      .limit(1);
    const shapeRow = shapeRows[0];
    const childSession = await this.deps.engineHost.sessionFor(
      watch.childSessionId,
      await loadSessionMeta(this.deps.db, {
        id: watch.childSessionId,
        userId: childData.userId,
        orgId: childData.orgId,
        workspace: childData.workspace,
        // Engine SessionData carries the owner Principal — thread it so a
        // team-owned child that rebuilds here keeps the team model tier.
        ownerType: childData.owner.type,
        ownerId: childData.owner.id,
        ...(shapeRow
          ? {
              profile: shapeRow.profile,
              docker: shapeRow.docker,
              kubernetes: shapeRow.kubernetes,
              sandboxResourceOverrides: shapeRow.sandboxResourceOverrides,
              credentialOwnerMode: shapeRow.credentialOwnerMode,
            }
          : {}),
      }),
    );
    // The spawner always prompts the child's default thread — see
    // `buildChildSpawner`'s `childSession.prompt(...)` call.
    const result = await childSession.thread().awaitResult(itemId);

    // Re-point guard (`child_send`): the sender moves the watch row to its
    // new submission and arms a fresh watcher on it. A watcher that wakes
    // for a submission the row no longer tracks must stay silent — the
    // settlement the parent is owed belongs to the row's current item.
    //
    // A followup send has a benign race: the original submission can
    // complete between the sender's prompt() and its row update, and the
    // stale watcher then reports that completion. That signal is truthful
    // — the child really finished the original work — and is the same
    // two-signal sequence the parent gets when a send lands just after
    // settlement (the re-open path). Admission and the row update cannot
    // be one transaction: the engine store and the app db are separate
    // pluggable contracts (the spawner's prompt-then-insert window is the
    // same shape).
    const rows = await this.deps.db
      .select({
        queueItemId: childWatches.queueItemId, settled: childWatches.settled,
        originJson: childWatches.originJson, replyRoute: childWatches.replyRoute,
      })
      .from(childWatches)
      .where(eq(childWatches.childSessionId, watch.childSessionId))
      .limit(1);
    const row = rows[0];
    if (!row || row.queueItemId !== watch.queueItemId) {
      // The watch moved to later work, so no new attempt admits this one.
      await this.resolveOrphanIntent(settledReplyId(watch.childSessionId, watch.queueItemId), watch.orgId);
      return;
    }

    // A superseded settlement is never reported — it is not a result. The
    // steer that superseded this item stamped its replacement on the queue
    // item; move the watch to the successor and watch that instead. This
    // self-heals a `child_send` that crashed between its steer admission
    // and its row update, and it follows a user's direct takeover of the
    // child (the parent then hears about the takeover's outcome). The
    // UPDATE is conditioned on the old queueItemId so a sender re-point
    // landing in between wins; double-arming the same successor is safe
    // (dispatchId idempotency + this guard).
    if (result.outcome === "superseded" && watch.resultItemId === undefined) {
      const item = await this.deps.engineStore.getQueueItem(watch.childSessionId, watch.queueItemId);
      const successor = item?.supersededByItemId;
      if (!successor) {
        // Steer supersession always stamps a successor; a missing one is
        // unexpected. Leave the row unsettled for the next boot's rearm.
        console.error(
          `ChildWatcher: ${watch.queueItemId} superseded with no successor; leaving ${watch.childSessionId} unsettled`,
        );
        return;
      }
      const successorItem = await this.deps.engineStore.getQueueItem(watch.childSessionId, successor);
      if (!successorItem) throw new Error(`Missing child successor submission ${successor}`);
      // This watcher owns the takeover decision. It reads the successor's
      // provenance, because parent work also names an author. Recovery of a
      // `child_send` whose sender stopped before it stored the route takes
      // the same route the sender would have stored. The stored origin never
      // changes.
      const replyRoute = nextReplyRoute(row.replyRoute, {
        delegated: isParentDelegation(successorItem), ...delegationSource(successorItem),
      }, { parentThreadId: watch.parentThreadId, originThreadKey: parseOriginJson(row.originJson)?.threadKey });
      await this.deps.db
        .update(childWatches)
        .set({ queueItemId: successor, settled: false, ...(replyRoute !== row.replyRoute ? { replyRoute } : {}) })
        .where(
          and(
            eq(childWatches.childSessionId, watch.childSessionId),
            eq(childWatches.queueItemId, watch.queueItemId),
          ),
        );
      this.arm({ ...watch, queueItemId: successor });
      return;
    }

    if (result.outcome === "superseded" || result.outcome === "merged") return;

    if (!digest) {
      const work = await this.backgroundWork(watch.childSessionId);
      const body = resultBody(result, watch.childSessionId,
        result.outcome === "failed" || result.outcome === "aborted"
          ? await this.latestContinuationCheckpoint(watch.childSessionId, childSession.thread().id) : undefined);
      await this.publish(watch, {
        key: "child.settled",
        dedupeKey: `settled:${watch.childSessionId}:${itemId}`,
        occurredAt: new Date().toISOString(),
        subjects: [`valet:session:${watch.childSessionId}`],
        refs: { child_session_id: watch.childSessionId, child_queue_item_id: itemId, watch_queue_item_id: watch.queueItemId,
          background_work: JSON.stringify(work) },
        status: result.outcome,
        summary: body + (work.length ? `\n\nOutstanding background work:\n${work.map((w) =>
          `- ${w.kind} ${w.id}: ${w.reason}. Deadline: ${w.deadline ?? "none"}.`).join("\n")}` : ""),
        payload: { outcome: result.outcome, backgroundWork: work },
      });
      return;
    }

    // Optional title attribute (decision 11): the spawn request's title is
    // mirrored onto the child's agent_sessions row — read it back from there
    // rather than widening child_watches with a redundant column.
    const appRows = await this.deps.db
      .select({ title: agentSessions.title })
      .from(agentSessions)
      .where(eq(agentSessions.id, watch.childSessionId))
      .limit(1);
    const title = appRows[0]?.title ?? undefined;
    const continuationCheckpoint =
      result.outcome === "failed" || result.outcome === "aborted"
        ? await this.latestContinuationCheckpoint(
            watch.childSessionId,
            childSession.thread().id,
          )
        : undefined;

    // Private input in this result's transcript downgrades an automatic
    // route to manual for good. Parent work never restores `origin`.
    let replyRoute = row.replyRoute;
    if (replyRoute === "origin" && await privateInputBefore(this.deps.engineStore, watch.childSessionId, itemId,
      { parentThreadId: watch.parentThreadId, originThreadKey: parseOriginJson(row.originJson)?.threadKey })) {
      replyRoute = "manual" satisfies ChildReplyRoute;
      await this.deps.db.update(childWatches).set({ replyRoute })
        .where(and(eq(childWatches.childSessionId, watch.childSessionId), eq(childWatches.replyRoute, "origin")));
    }
    const origin = settlementOrigin(row.originJson, replyRoute);
    const replyId = namespaceInternalDispatchId(watch.childSessionId, `settled:${watch.childSessionId}:${itemId}`);
    const automaticReply = origin !== undefined && origin.reply !== "manual";
    // Write the intent before the parent can finish. Dispatch-ID lookup recovers a lost receipt.
    if (automaticReply) await this.openReplyIntent({ ...watch, queueItemId: itemId }, replyId);
    const receipt = await admitSignal(this.deps, {
      from: { sessionId: watch.childSessionId, owner: childData.owner },
      to: watch.parentSessionId,
      threadKey: watch.parentThreadId,
      content: {
        kind: "signal",
        signalType: "child.settled",
        body: digest.summary,
        attributes: {
          child_session_id: watch.childSessionId,
          outcome: result.outcome,
          background_work: digest.refs?.background_work ?? "[]",
          ...(title !== undefined ? { title } : {}),
          ...(continuationCheckpoint !== undefined
            ? { continuation_checkpoint_entry_id: continuationCheckpoint.id }
            : {}),
        },
        // Preserve the spawning turn's route and reply policy for the parent's update.
        ...(origin !== undefined ? { origin } : {}),
      },
      toolScope: intersectToolScopes(readToolScope(childData.metadata?.[TOOL_SCOPE_KEY]), readToolScope((await this.deps.engineStore.getQueueItem(watch.childSessionId, itemId))?.metadata?.[TOOL_SCOPE_KEY])),
      dispatchId: `settled:${watch.childSessionId}:${itemId}`,
    });

    if (automaticReply) {
      // A landed admission always re-opens a reply that was never sent, even
      // one ended while this admission was in flight.
      await this.deps.db.update(childReplyDeliveries).set({
        queueItemId: receipt.queueItemId, completedAt: null, failedAt: null, attempts: 0, lastError: null, nextAttemptAt: Date.now(),
      }).where(and(eq(childReplyDeliveries.id, replyId), eq(childReplyDeliveries.orgId, watch.orgId), isNull(childReplyDeliveries.queueItemId)));
    }
    await this.markSettled(watch.childSessionId, watch.queueItemId);
    await this.parkChildSandbox(watch.childSessionId);
  }

  /**
   * Ends the open reply intent of child work whose watch moved on and that
   * no attempt in this process is admitting. A landed admission completes
   * it with its receipt. Otherwise it is abandoned: the parent hears about
   * the later work instead. An admission that still lands re-opens it.
   */
  private async resolveOrphanIntent(replyId: string, orgId: string): Promise<void> {
    const open = and(eq(childReplyDeliveries.id, replyId), eq(childReplyDeliveries.orgId, orgId),
      isNull(childReplyDeliveries.queueItemId), isNull(childReplyDeliveries.completedAt), isNull(childReplyDeliveries.failedAt));
    const [intent] = await this.deps.db.select({ sessionId: childReplyDeliveries.sessionId }).from(childReplyDeliveries).where(open).limit(1);
    if (!intent) return;
    const admitted = await this.deps.engineStore.getQueueItemByDispatchId(intent.sessionId, replyId);
    await this.deps.db.update(childReplyDeliveries).set(admitted
      ? { queueItemId: admitted.id }
      : { completedAt: Date.now(), lastError: "The child watch moved to later work before this update was admitted." }).where(open);
  }

  /**
   * Writes the reply intent before an admission attempt. An intent that
   * failed before any parent update was admitted is opened again: this
   * watcher is about to admit that update, so the earlier failure no longer
   * holds, and its problem record goes with it. An intent with an admitted
   * update keeps its state, so a delivered reply never posts twice.
   */
  private async openReplyIntent(watch: ArmArgs, replyId: string): Promise<void> {
    const now = Date.now();
    await this.deps.db.transaction(async (tx) => {
      const reopened = await tx.insert(childReplyDeliveries).values({
        id: replyId, orgId: watch.orgId, sessionId: watch.parentSessionId, threadId: watch.parentThreadId,
        childSessionId: watch.childSessionId, childQueueItemId: watch.queueItemId, nextAttemptAt: now, createdAt: now,
      }).onConflictDoUpdate({
        target: childReplyDeliveries.id,
        set: { failedAt: null, attempts: 0, lastError: null, nextAttemptAt: now },
        setWhere: and(eq(childReplyDeliveries.orgId, watch.orgId), isNull(childReplyDeliveries.queueItemId),
          isNotNull(childReplyDeliveries.failedAt)),
      }).returning({ failedAt: childReplyDeliveries.failedAt });
      if (reopened.length > 0) {
        await tx.delete(eventDropLog).where(and(eq(eventDropLog.id, `child-reply:${replyId}`), eq(eventDropLog.orgId, watch.orgId)));
      }
    });
  }

  /** Snapshot of work owed after this turn. Settlement does not wait for it. */
  private async backgroundWork(childSessionId: string): Promise<Array<{ id: string; kind: string; reason: string; deadline?: string }>> {
    const leases = await this.deps.engineStore.listActiveLeases(childSessionId);
    const wakeups = await this.deps.engineStore.listWakeups(childSessionId, ["pending", "running"]);
    return [
      ...leases.map((lease) => ({ id: lease.id, kind: lease.ownerKind, reason: lease.reason,
        deadline: new Date(lease.deadlineAt).toISOString() })),
      ...wakeups.filter((w) => w.kind === "timer" || w.kind === "event").map((w) => ({
        id: w.id, kind: w.kind, reason: w.reason,
        ...((w.fireAt ?? w.deadlineAt) !== undefined ? { deadline: new Date(w.fireAt ?? w.deadlineAt ?? 0).toISOString() } : {}),
      })),
    ];
  }

  /** A cancelled subscription stays cancelled when child_send reopens the child. */
  async ensureSubscription(watch: Pick<ArmArgs, "childSessionId" | "parentSessionId" | "parentThreadId">): Promise<void> {
    const id = `wk_child_events:${watch.childSessionId}`;
    if (await this.deps.engineStore.getWakeup(id)) return;
    const now = Date.now();
    await this.deps.engineStore.createWakeup({
      id, sessionId: watch.parentSessionId, threadId: watch.parentThreadId,
      kind: "event", status: "running", reason: `Child updates: ${watch.childSessionId}`,
      subjects: [`valet:session:${watch.childSessionId}`],
      eventMatch: { childSessionId: watch.childSessionId, clauses: [{ key: "child.*" }], once: false, self: [], minIntervalMs: 0 },
      logOffset: 0, logTail: "", eventCount: 0, createdAt: now, updatedAt: now,
    }).catch(async (error: unknown) => {
      // Concurrent arms can race this insert. The existing row owns its cancellation state.
      if (!(await this.deps.engineStore.getWakeup(id))) throw error;
    });
  }

  /** The subscription follows the child's lifetime, including idle periods. */
  async subscriptionActive(row: Wakeup): Promise<boolean> {
    const child = row.eventMatch?.childSessionId;
    if (!child) return false;
    const [session] = await this.deps.db.select({ status: agentSessions.status }).from(agentSessions)
      .where(eq(agentSessions.id, child)).limit(1);
    return session?.status !== "archived" && session?.status !== "deleted"
      && (await this.deps.engineStore.getSession(child)) !== null;
  }

  private async publish(watch: ArmArgs, event: NormalizedEvent): Promise<void> {
    const waiter = await this.deps.engineStore.getWakeup(`wk_child_events:${watch.childSessionId}`);
    if (waiter?.status !== "running") {
      if (event.key !== "child.settled") return;
      await this.markSettled(watch.childSessionId, watch.queueItemId);
      await this.parkChildSandbox(watch.childSessionId);
      return;
    }
    await ingestEvent({ db: this.deps.db, plugins: [], waiters: {
      engineStore: this.deps.engineStore, plugins: [], now: Date.now,
      sessionOrg: async (id) => {
        const data = await this.deps.engineStore.getSession(id);
        if (data) return { orgId: data.orgId, ownerType: data.owner.type, ownerId: data.owner.id };
        // The waiter still matches when its recipient vanished. Delivery owns edge denial logging.
        if (id === watch.parentSessionId) return { orgId: watch.orgId, ownerType: "user", ownerId: watch.actorUserId };
        return null;
      },
      slackStillVisible: async () => false,
      resolvePreviousStatus: async () => null,
      slackBotUserId: async () => undefined,
    } }, { orgId: watch.orgId, service: "valet", event });
    const buffered = await this.deps.engineStore.getWakeup(waiter.id);
    if (buffered?.status === "running" && ![...(buffered.eventBuffer ?? []).map((d) => d.dedupeKey),
      ...(buffered.eventSourceSeen ?? [])].includes(event.dedupeKey)) {
      throw new Error(`Child event ${event.dedupeKey} was not buffered. Retry ingestion.`);
    }
  }

  /** Called only by WakeWatcher after ingest matched this child subscription. */
  async deliverEvent(row: Wakeup, digest: EventMatchDigest): Promise<void> {
    const child = row.eventMatch?.childSessionId;
    if (!child || digest.refs?.child_session_id !== child) return;
    const [stored] = await this.deps.db.select().from(childWatches).where(eq(childWatches.childSessionId, child)).limit(1);
    if (!stored || stored.parentSessionId !== row.sessionId || stored.parentThreadId !== row.threadId ||
      stored.queueItemId !== (digest.refs.watch_queue_item_id ?? digest.refs.child_queue_item_id)) return;
    const watch = watchRowToArgs(stored);
    try {
      if (digest.key === "child.gate_opened") {
        const gate = await this.deps.engineStore.getDecisionGate(child, digest.refs.gate_id ?? "");
        if (gate?.status === "pending") await this.deliverGate(watch, gate);
      } else if (digest.key === "child.settled") {
        await this.attempt({ ...watch, resultItemId: digest.refs.child_queue_item_id }, digest);
      }
    } catch (error) {
      const classification = classifyWatcherError(error);
      if (classification.kind === "retryable") {
        if (classification.pendingCap) await writeDropLog(this.deps.db, {
          orgId: watch.orgId, reason: "pending_cap", conversationKey: watch.queueItemId,
          detail: `Child event delivery deferred on parent thread ${row.threadId}: pending cap reached.`,
        });
        throw error;
      }
      if (!classification.alreadyLogged) await writeDropLog(this.deps.db, {
        orgId: watch.orgId, reason: "edge_denied", conversationKey: digest.dedupeKey, detail: String(error),
      });
      await this.deps.db.update(childReplyDeliveries).set({ failedAt: Date.now(), lastError: String(error).slice(0, 1_000) })
        .where(and(eq(childReplyDeliveries.id, settledReplyId(child, digest.refs.child_queue_item_id ?? watch.queueItemId)),
          eq(childReplyDeliveries.orgId, watch.orgId), isNull(childReplyDeliveries.queueItemId)));
      await this.markSettled(child, watch.queueItemId);
    }
  }

  /** Later signal turns retain the delegation generation used by the stale-watch guard. */
  async observeTurn(childSessionId: string, queueItemId: string): Promise<void> {
    const [row] = await this.deps.db.select().from(childWatches)
      .where(eq(childWatches.childSessionId, childSessionId)).limit(1);
    if (!row || row.queueItemId === queueItemId) return;
    const next = await this.deps.engineStore.getQueueItem(childSessionId, queueItemId);
    if (!next || !isSignalSubmission(next) || next.outcome?.outcome === "merged" || next.outcome?.outcome === "superseded") return;
    this.arm({ ...watchRowToArgs(row), resultItemId: queueItemId });
  }

  private async latestContinuationCheckpoint(
    childSessionId: string,
    childThreadId: string,
  ): Promise<CompactionEntry | undefined> {
    const snapshot = await this.deps.engineStore.getThreadSnapshot(
      childSessionId,
      childThreadId,
    );
    if (!snapshot) return undefined;
    const activeEntries = walkTranscriptDag(
      snapshot.entries,
      snapshot.thread.activeLeafEntryId,
    );
    for (let index = activeEntries.length - 1; index >= 0; index--) {
      const entry = activeEntries[index];
      if (entry.type === "compaction") return entry;
    }
    return undefined;
  }

  private async markSettled(childSessionId: string, queueItemId: string): Promise<void> {
    // Conditioned on the queueItemId this watcher tracked: a sender
    // re-point that landed after this watcher's row check must not be
    // clobbered back to settled, or the re-pointed submission's watcher
    // goes silent and the settlement is lost. `settledAt` starts (or
    // restarts) the retention clock; clearing `sandboxReclaimedAt` opens a
    // fresh reclaim cycle for a re-opened child. `parkedSandboxId` is
    // deliberately kept — it is the only durable handle to a sandbox a
    // prior cycle parked, and the next park overwrites it anyway.
    await this.deps.db
      .update(childWatches)
      .set({ settled: true, settledAt: Date.now(), sandboxReclaimedAt: null })
      .where(and(eq(childWatches.childSessionId, childSessionId), eq(childWatches.queueItemId, queueItemId)));
  }

  private async markReclaimed(childSessionId: string, now: number): Promise<void> {
    await this.deps.db
      .update(childWatches)
      .set({ sandboxReclaimedAt: now })
      .where(eq(childWatches.childSessionId, childSessionId));
  }

  /**
   * Park or reclaim a settled child's compute. With `child_send` in the
   * toolset a settled child is revivable, so on a hibernation-capable
   * backend (and retention on) the sandbox is suspended — scaled to zero,
   * workspace retained, tokens kept — and `sweepRetention` owns the real
   * destroy once the retention window passes. Backends without hibernation
   * (docker/local) keep the original eager destroy: their revival always
   * cold-starts, so holding the sandbox buys nothing. Session data stays
   * either way: `child_read` and the Sessions page keep working.
   * Best-effort — a failure here never un-settles the watch.
   */
  private async parkChildSandbox(childSessionId: string): Promise<void> {
    try {
      const live = this.deps.engineHost.liveSession(childSessionId);
      if (!live) return;
      // A user can wake a settled child from the Sessions page. A prompt
      // admitted between the settle and this park must not lose its
      // sandbox mid-turn — skip and let the idle sweep own the reclaim.
      const unsettled = await this.deps.engineStore.listUnsettledSubmissions(childSessionId);
      if (unsettled.length > 0) return;

      if (await this.holdsBackgroundWork(childSessionId)) return;

      const retentionMs = this.deps.retentionMs ?? 0;
      const retainable = retentionMs > 0 && this.deps.engineHost.sandboxHibernationCapable();
      const action = childParkAction(live.attachment.state, retainable);
      if (action === "skip") return;
      if (action === "record_suspended") {
        // Already suspended (the idle sweep got there first): the sandbox
        // is parked as-is. Record the handle — suspend keeps it live on
        // the attachment — and leave the reclaim to `sweepRetention`.
        const sandboxId = live.attachment.sandboxId;
        if (sandboxId) {
          await this.deps.db
            .update(childWatches)
            .set({ parkedSandboxId: sandboxId })
            .where(eq(childWatches.childSessionId, childSessionId));
        }
        await writeHibernated(this.deps.db, childSessionId);
        return;
      }
      if (action === "suspend") {
        // Record the provider handle BEFORE suspending: the retention
        // sweep needs it once an api restart evicts the cached session,
        // and nothing else durably tracks a provisioned sandbox's id.
        const sandboxId = live.attachment.sandboxId;
        if (sandboxId) {
          await this.deps.db
            .update(childWatches)
            .set({ parkedSandboxId: sandboxId })
            .where(eq(childWatches.childSessionId, childSessionId));
        }
        await live.attachment.suspend();
        // Same status stamp the idle sweep's onHibernate hook writes, so
        // the Sessions page shows the parked child as hibernated.
        await writeHibernated(this.deps.db, childSessionId);
        // No token revoke and no cache evict: the wake path needs both.
        // `sandboxReclaimedAt` stays NULL — the reclaim is owed to
        // `sweepRetention`.
        return;
      }

      await live.attachment.destroy("child_settled");
      this.deps.engineHost.evictCache(childSessionId);
      // The sandbox bearer token outlives the container on backends whose
      // creds live outside it (docker host-dir mount) — revoke like
      // `EngineHost.destroy` does.
      await revokeSandboxTokens(this.deps.db, childSessionId);
      await this.markReclaimed(childSessionId, Date.now());
    } catch (err) {
      console.error(`ChildWatcher: sandbox park failed for settled child ${childSessionId}:`, err);
    }
  }

  /**
   * Destroy parked child sandboxes whose retention window has passed:
   * settled rows with no reclaim stamp and a `settledAt` older than
   * `retentionMs`. Runs on an interval (`startRetentionSweep`) and is
   * directly callable for tests. Per-row best-effort: one bad child never
   * blocks the rest.
   *
   * Eligibility needs BOTH clocks stale: `settledAt` (the watcher's
   * settlement stamp) and the engine's `latestActivityAt`. A user can
   * converse with a parked child from the Sessions page without touching
   * `child_watches` — the activity clock is what keeps the sweep from
   * destroying a sandbox out from under that conversation (the same clock
   * the host idle sweep trusts).
   *
   * A child with unsettled submissions is skipped, with the check
   * re-checked immediately before the destroy (the idle sweep's race
   * rule): a `child_send` or user prompt admitted in between wins. A
   * child no longer in the host cache (an api restart evicted it) is
   * reclaimed through the `parkedSandboxId` recorded at park time.
   */
  async sweepRetention(now = Date.now()): Promise<void> {
    const retentionMs = this.deps.retentionMs ?? 0;
    const cutoff = now - retentionMs;
    const rows = await this.deps.db
      .select()
      .from(childWatches)
      .where(
        and(
          eq(childWatches.settled, true),
          isNull(childWatches.sandboxReclaimedAt),
          lte(childWatches.settledAt, cutoff),
        ),
      );
    for (const row of rows) {
      try {
        const unsettled = await this.deps.engineStore.listUnsettledSubmissions(row.childSessionId);
        if (unsettled.length > 0) continue;
        const activityAt = await this.deps.engineStore.latestActivityAt(row.childSessionId);
        if (activityAt != null && activityAt > cutoff) continue;
        if (await this.holdsBackgroundWork(row.childSessionId)) continue;
        const live = this.deps.engineHost.liveSession(row.childSessionId);
        const sandboxId = (await this.deps.engineStore.getSession(row.childSessionId))?.sandboxId ?? row.parkedSandboxId;
        if (live) {
          // Race rule (mirrors `maybeSuspendIdleSession`): re-check
          // immediately before the destroy — a submission admitted since
          // the check above wins and the reclaim waits for the next pass.
          const recheck = await this.deps.engineStore.listUnsettledSubmissions(row.childSessionId);
          if (recheck.length > 0) continue;
          if (await this.holdsBackgroundWork(row.childSessionId)) continue;
          await live.attachment.destroy("child_retention");
          this.deps.engineHost.evictCache(row.childSessionId);
        } else if (sandboxId) {
          await this.deps.engineHost.destroySandbox(sandboxId);
          recordSandboxDestroyed("child_retention");
        } else {
          // Nothing destroyable from here: no cached session and no
          // recorded handle. Stamp the reclaim so the row stops sweeping,
          // but say so — if a sandbox exists (e.g. kept by the
          // permanent-denial path and orphaned by a restart), the idle
          // sweep or operator owns it now.
          console.warn(
            `ChildWatcher: retention reclaim for ${row.childSessionId} found no live session and no parked sandbox id; stamping reclaimed without a destroy`,
          );
        }
        await revokeSandboxTokens(this.deps.db, row.childSessionId);
        await this.markReclaimed(row.childSessionId, now);
      } catch (err) {
        console.error(`ChildWatcher: retention reclaim failed for child ${row.childSessionId}:`, err);
      }
    }
  }

  /**
   * True while the child holds a lease, a pending timer, or a running event
   * waiter. A person can prompt a settled child to start long work, and
   * that work must keep its sandbox past the retention window (fix wave 3,
   * concurrency M2; spec INV-8). Logged once per child.
   */
  private async holdsBackgroundWork(childSessionId: string): Promise<boolean> {
    const store = this.deps.engineStore;
    const leases = await store.countActiveLeases(childSessionId);
    // An event waiter holds no lease (INV-E3) and is always "running", never
    // "pending" (spec 2026-10-15, F2), so it needs its own count.
    const open = leases > 0 ? [] : await store.listWakeups(childSessionId, ["pending", "running"]);
    const timers = open.filter((w) => w.kind === "timer" && w.status === "pending").length;
    const events = open.filter((w) => w.kind === "event" && w.status === "running").length;
    if (leases === 0 && timers === 0 && events === 0) {
      this.keptForWork.delete(childSessionId);
      return false;
    }
    if (!this.keptForWork.has(childSessionId)) {
      this.keptForWork.add(childSessionId);
      console.warn(
        `ChildWatcher: retention keeps ${childSessionId} past its window: it holds ${leases} lease(s), ${timers} pending timer(s), and ${events} event waiter(s).`,
      );
    }
    return true;
  }

  /** Sweeps deferred background-work reclaims even when warm retention is off. */
  startRetentionSweep(): void {
    if (this.retentionTimer) return;
    const intervalMs = this.deps.retentionSweepIntervalMs ?? DEFAULT_RETENTION_SWEEP_INTERVAL_MS;
    this.retentionTimer = startSweepTimer("ChildWatcher retention", intervalMs, () => this.sweepRetention());
  }

  stopRetentionSweep(): void {
    this.retentionTimer?.stop();
    this.retentionTimer = undefined;
  }

  /** Recovers subscriptions, unpublished turns, and admitted reply intents at boot. */
  async rearm(): Promise<void> {
    // After a restart no admission is in flight. An open reply intent whose
    // watch moved to later work has no watcher left to admit it.
    const orphans = await this.deps.db.select().from(childReplyDeliveries).where(and(
      isNull(childReplyDeliveries.queueItemId), isNull(childReplyDeliveries.completedAt), isNull(childReplyDeliveries.failedAt),
      isNotNull(childReplyDeliveries.childSessionId), isNotNull(childReplyDeliveries.childQueueItemId)));
    for (const intent of orphans) {
      if (!intent.childSessionId) continue;
      const [watch] = await this.deps.db.select({ queueItemId: childWatches.queueItemId }).from(childWatches)
        .where(eq(childWatches.childSessionId, intent.childSessionId)).limit(1);
      if (watch?.queueItemId === intent.childQueueItemId) continue;
      await this.resolveOrphanIntent(intent.id, intent.orgId);
    }
    const rows = await this.deps.db.select().from(childWatches);
    for (const row of rows) {
      await this.ensureSubscription(watchRowToArgs(row));
      const waiter = await this.deps.engineStore.getWakeup(`wk_child_events:${row.childSessionId}`);
      if (!waiter || !(await this.subscriptionActive(waiter))) continue;
      const current = await this.deps.engineStore.getQueueItem(row.childSessionId, row.queueItemId);
      const turns = await this.deps.engineStore.listSettledSubmissionsBefore(row.childSessionId, Date.now() + 1);
      for (const turn of turns) {
        if (turn.createdAt < (current?.createdAt ?? 0) || !isSignalSubmission(turn)) continue;
        const dispatchId = settledReplyId(row.childSessionId, turn.id);
        if (!(await this.deps.engineStore.getQueueItemByDispatchId(row.parentSessionId, dispatchId))) {
          await this.observeTurn(row.childSessionId, turn.id);
        }
      }
      const replyId = settledReplyId(row.childSessionId, row.queueItemId);
      const admitted = await this.deps.engineStore.getQueueItemByDispatchId(row.parentSessionId, replyId);
      if (admitted) {
        await this.deps.db.update(childReplyDeliveries).set({ queueItemId: admitted.id })
          .where(and(eq(childReplyDeliveries.id, replyId), isNull(childReplyDeliveries.queueItemId)));
        await this.markSettled(row.childSessionId, row.queueItemId);
        await this.parkChildSandbox(row.childSessionId);
      } else this.arm(watchRowToArgs(row));
    }
  }
}

/** Messages `child_read` returns when the caller names no limit. */
const CHILD_READ_DEFAULT_LIMIT = 30;

/**
 * Builds the `ChildReader` injected into every orchestrator's
 * `toolConfig.childReader`, which is what the engine's `child_read` built-in
 * calls.
 *
 * Authority comes from `child_watches`: a row exists only because this
 * parent spawned this child, and `markSettled` updates the row instead of
 * deleting it, so the edge outlives the child's run. A settled child stays
 * readable, which is the point — the parent reads it after the truncated
 * result arrives.
 */
/** Observes child gates and later signal turns. Wire before boot recovery. */
export function wireChildGateReports(eventStream: EventStream, watcher: ChildWatcher): () => void {
  return eventStream.subscribe({ eventTypes: ["decision_gate", "submission_settled"] }, (delivered) => {
    if (delivered.event.type === "submission_settled") {
      watcher.observeTurn(delivered.sessionId, delivered.event.queueItemId).catch((err) => {
        console.error(`child turn observation failed for ${delivered.sessionId}:`, err);
      });
      return;
    }
    if (delivered.event.type !== "decision_gate") return;
    watcher.reportGateOpened(delivered.sessionId, delivered.event.gate).catch((err) => {
      console.error(`child gate report failed for ${delivered.sessionId}:`, err);
    });
  });
}

/**
 * Whether a parent thread may reach a child: read it, check on it, or steer
 * it. In a team runtime, a child started from a private thread (a person's
 * helper, or a private Slack channel's) is reached only from that thread,
 * so another thread cannot repeat or redirect its work for the whole team.
 * Without a thread to check, the session-level edge decides.
 */
async function childReachableFrom(
  db: AppDb,
  watch: { parentThreadId: string; orgId: string },
  parentSessionId: string,
  readerThreadId: string | undefined,
): Promise<boolean> {
  if (readerThreadId === undefined || readerThreadId === watch.parentThreadId) return true;
  const governing = governingThreadKeySql(sql`${parentSessionId}`, sql`${watch.parentThreadId}`, "parent link");
  const channels = threadSlackChannelsSql(sql`${parentSessionId}`, sql`${watch.parentThreadId}`);
  const result = await db.execute(sql`SELECT s.owner_type, ${governing} AS key, ${sharedWithWholeTeamSql(watch.orgId, governing, channels)} AS shared,
    ${channels} AS channels,
    (SELECT t.key FROM engine_threads t WHERE t.session_id = s.id AND t.id = ${readerThreadId}) AS reader_key,
    ${threadSlackChannelsSql(sql`${parentSessionId}`, sql`${readerThreadId}`)} AS reader_channels
    FROM engine_sessions s WHERE s.id = ${parentSessionId}`) as { rows: Array<{
      owner_type: string; key: string | null; shared: boolean; channels: string[] | null; reader_key: string | null; reader_channels: string[] | null;
    }> };
  const parent = result.rows[0];
  // A parent that is gone leaves nobody to say who may read its child.
  if (!parent) return false;
  if (parent.owner_type !== "team") return true;
  // A Slack, Telegram, or GitHub conversation, or a thread holding Slack
  // content, reaches only what it may read with `thread_read`
  // (`services/thread-access.ts#threadReadAccess`).
  const readerChannels = parent.reader_channels ?? [];
  if (isOutsideReader(parent.reader_key, readerChannels)) {
    return outsideReaderMayReach({ key: parent.reader_key, channels: readerChannels },
      { key: parent.key, channels: parent.channels ?? [] }, parent.shared === true);
  }
  return parent.shared === true;
}

export function buildChildReader(deps: ChildrenDeps): ChildReader {
  return async (req, ctx) => {
    const rows = await deps.db
      .select({ childSessionId: childWatches.childSessionId, parentThreadId: childWatches.parentThreadId, orgId: childWatches.orgId })
      .from(childWatches)
      .where(
        and(
          eq(childWatches.childSessionId, req.childSessionId),
          eq(childWatches.parentSessionId, ctx.parentSessionId),
        ),
      )
      .limit(1);
    // No row means the caller does not own this child, or it does not
    // exist. Both answer `null`: telling them apart would confirm that
    // somebody else's session id is real.
    const watch = rows[0];
    if (!watch) return null;
    if (!(await childReachableFrom(deps.db, watch, ctx.parentSessionId, ctx.readerThreadId))) return null;

    const childRows = await deps.db
      .select({ status: agentSessions.status })
      .from(agentSessions)
      .where(eq(agentSessions.id, req.childSessionId))
      .limit(1);
    const child = childRows[0];
    // A deleted child answers the same null as a missing one — deletion
    // must not leave the transcript readable through the watch edge.
    if (!child || child.status === "deleted") return null;

    // Read the store directly. Waking the child through the engine host
    // would mint a sandbox token, run reconcile (resuming any unsettled
    // work under the reader's timing), and re-create engine rows for a
    // child deleted while cached — a read must do none of that.
    const data = await deps.engineStore.getSession(req.childSessionId);
    if (!data) return null;
    const threads = await deps.engineStore.listThreads(req.childSessionId);
    // The spawner prompts the child's default thread ("web:default").
    const thread = threads.find((t) => t.key === "web:default") ?? threads[0];
    if (!thread) return [];
    return deps.engineStore.getEntries(req.childSessionId, thread.id, {
      limit: req.limit ?? CHILD_READ_DEFAULT_LIMIT,
      includeCompacted: true,
    });
  };
}

/**
 * Reports durable child turn state to child_status and security completion.
 * Status reads do not acknowledge event delivery or start sandbox retention.
 * A missing, foreign, or deleted child answers null.
 */
export async function resolveChildSettlement(
  deps: ChildrenDeps,
  childSessionId: string,
  parentSessionId: string,
): Promise<{ settled: boolean; lastActivityAt: number | null } | null> {
  const rows = await deps.db
    .select({
      settled: childWatches.settled,
    })
    .from(childWatches)
    .where(
      and(
        eq(childWatches.childSessionId, childSessionId),
        eq(childWatches.parentSessionId, parentSessionId),
      ),
    )
    .limit(1);
  // No row means the caller does not own this child, or it does not exist.
  // Both answer `null`: telling them apart would confirm that somebody else's
  // session id is real.
  if (rows.length === 0) return null;

  const childRows = await deps.db
    .select({ status: agentSessions.status })
    .from(agentSessions)
    .where(eq(agentSessions.id, childSessionId))
    .limit(1);
  const child = childRows[0];
  // A deleted child answers the same null as a missing one.
  if (!child || child.status === "deleted") return null;

  const lastActivityAt = await deps.engineStore.latestActivityAt(childSessionId);
  const rowSettled = rows[0].settled === true;
  const unsettled = await deps.engineStore.listUnsettledSubmissions(childSessionId);
  if (unsettled.length > 0) return { settled: false, lastActivityAt };
  if (rowSettled) return { settled: true, lastActivityAt };
  const settledSubs = await deps.engineStore.listSettledSubmissionsBefore(childSessionId, Date.now());
  const settled = settledSubs.length > 0;

  return { settled, lastActivityAt };
}

/**
 * Builds the `ChildStatusReader` injected into every orchestrator's
 * `toolConfig.childStatusReader` — the backend of the engine's
 * `child_status` built-in. A thin wrapper over `resolveChildSettlement`, the
 * one settlement definition. Authority is the same `child_watches` edge as
 * `buildChildReader`. The activity clock reads the engine store directly:
 * a status check must never wake the child (no sandbox token, no
 * reconcile, no engine rows for a deleted child).
 */
export function buildChildStatusReader(deps: ChildrenDeps): ChildStatusReader {
  return async (req, ctx) => {
    if (ctx.readerThreadId !== undefined) {
      const [watch] = await deps.db.select({ parentThreadId: childWatches.parentThreadId, orgId: childWatches.orgId }).from(childWatches)
        .where(and(eq(childWatches.childSessionId, req.childSessionId), eq(childWatches.parentSessionId, ctx.parentSessionId))).limit(1);
      if (!watch || !(await childReachableFrom(deps.db, watch, ctx.parentSessionId, ctx.readerThreadId))) return null;
    }
    return resolveChildSettlement(deps, req.childSessionId, ctx.parentSessionId);
  };
}

/**
 * Builds the `ChildSender` injected into every orchestrator's
 * `toolConfig.childSender`, which is what the engine's `child_send` built-in
 * calls. This is the steering half of the child toolset: `task` spawns,
 * `child_read` reads, `child_send` redirects or re-opens.
 *
 * Authority is the same `child_watches` edge as `buildChildReader`. Unlike
 * the reader, a send goes through `engineHost.sessionFor` on purpose — it
 * must wake the child (cold-starting a torn-down sandbox if the child
 * already settled) so the queue actually runs the new submission.
 *
 * After admitting the message, the watch row is re-pointed at the new
 * submission (`settled: false`, dismissal cleared) and the watcher
 * re-armed, so the parent's next `child.settled` signal reports the steered
 * work. `parentThreadId` is deliberately NOT re-pointed: the spawn origin
 * is the durable edge the UI's child grouping and the child's approval-gate
 * routing resolve through, so the settlement lands on the thread that
 * commissioned the work even when the steer came from another thread.
 * Sends steer by default, superseding the child's in-flight work. A caller
 * can set `queue: true` to wait for the current turn and keep a pending
 * approval actionable. Steering withdraws a gate-blocked turn's approval.
 * The stale watcher follows the successor via the re-point guard in
 * `ChildWatcher.attempt`.
 *
 * Re-opening a settled child re-enters the active-children population, so
 * it pays the same decision-21 limit check as a spawn. Sends to one child
 * are serialized in-process so two concurrent sends cannot leave the row
 * tracking the older of their two submissions.
 */
export function buildChildSender(deps: ChildrenDeps, watcher: ChildWatcher): ChildSender {
  // Per-child promise chain. The api is a single process, so this is the
  // only writer path for sender re-points; serializing here keeps the row's
  // queueItemId tracking the LAST admitted submission.
  const chains = new Map<string, Promise<{ queueItemId: string } | null>>();

  const send = async (
    req: { childSessionId: string; message: string; queue?: boolean },
    ctx: { parentSessionId: string; parentThreadId: string; actorUserId: string; toolScope?: ToolScope; unattendedWorkflow?: boolean; parentQueueItemId?: string },
  ): Promise<{ queueItemId: string } | null> => {
    const watchRows = await deps.db
      .select()
      .from(childWatches)
      .where(
        and(
          eq(childWatches.childSessionId, req.childSessionId),
          eq(childWatches.parentSessionId, ctx.parentSessionId),
        ),
      )
      .limit(1);
    // Same null contract as `buildChildReader`: "not yours" and "does not
    // exist" are indistinguishable, so foreign session ids stay unguessable.
    const watchRow = watchRows[0];
    if (!watchRow || !(await childReachableFrom(deps.db, watchRow, ctx.parentSessionId, ctx.parentThreadId))) return null;

    const childRows = await deps.db
      .select({
        id: agentSessions.id,
        userId: agentSessions.userId,
        orgId: agentSessions.orgId,
        workspace: agentSessions.workspace,
        profile: agentSessions.profile,
        docker: agentSessions.docker,
        kubernetes: agentSessions.kubernetes,
        sandboxResourceOverrides: agentSessions.sandboxResourceOverrides,
        status: agentSessions.status,
        // Owner columns feed SessionMeta.ownerTeamId so a rebuild of a
        // team-owned child keeps the team tier of the model cascade.
        ownerType: agentSessions.ownerType,
        ownerId: agentSessions.ownerId,
        // A child stamped `actor` keeps acting-member credential reads
        // across a rebuild.
        credentialOwnerMode: agentSessions.credentialOwnerMode,
      })
      .from(agentSessions)
      .where(eq(agentSessions.id, req.childSessionId))
      .limit(1);
    const child = childRows[0];
    if (!child || child.status === "deleted") return null;

    // A settled child rejoins the active-children population — enforce the
    // same caps a spawn pays, BEFORE waking anything. A steer/followup to a
    // still-running child changes no counts and pays nothing.
    if (watchRow.settled) {
      await enforceLimits(deps.db, ctx.parentSessionId, watchRow.orgId, deps.orgSessionCeiling);
    }

    const childData = await deps.engineStore.getSession(req.childSessionId);
    if (!childData) return null;

    // Pass the app row as the meta source: it carries the persisted
    // profile, Docker flag, and resource overrides, so a post-restart
    // rebuild keeps the child's sandbox shape.
    const childSession = await deps.engineHost.sessionFor(
      req.childSessionId,
      await loadSessionMeta(deps.db, child),
    );
    // A child_send is USE: a parked (hibernated) child's row heals to
    // active even when the revived turn never touches the sandbox.
    await deps.engineHost.markSessionUsed(req.childSessionId);

    const parentData = await deps.engineStore.getSession(ctx.parentSessionId);
    if (!parentData || parentData.orgId !== watchRow.orgId) return null;
    const toolScope = intersectToolScopes(ctx.toolScope, readToolScope(parentData.metadata?.[TOOL_SCOPE_KEY]));
    const promptOptions = childSendPromptOptions({ ...ctx, toolScope,
      ...(ctx.unattendedWorkflow ? { workflowStep: await submissionWorkflowStep(deps.engineStore, ctx.parentSessionId, ctx.parentQueueItemId) } : {}) }, req.queue === true);
    const receipt = await childSession.prompt(req.message, promptOptions);

    // Re-point BEFORE arming: the fresh watcher must find the row already
    // tracking its submission, and the stale watcher (if any) must find it
    // no longer tracking the old one. Clearing `dismissedAt` keeps a
    // re-opened child visible in the orchestrator's child list — a hidden
    // row must never be running.
    await deps.db.transaction(async (tx) => {
      // Only a channel turn on the delegating thread keeps automatic posts to
      // its channel thread (`nextReplyRoute`). Otherwise the parent replies
      // to the channel thread only when it chooses to (`reply: "manual"`).
      // Read the route under a row lock: a takeover can change it while
      // this sender wakes the child.
      const [current] = await tx.select({ replyRoute: childWatches.replyRoute }).from(childWatches)
        .where(eq(childWatches.childSessionId, req.childSessionId)).for("update");
      const replyRoute = nextReplyRoute(current?.replyRoute ?? null, {
        delegated: true, ...delegationSource({ metadata: promptOptions.metadata }),
      }, { parentThreadId: watchRow.parentThreadId, originThreadKey: parseOriginJson(watchRow.originJson)?.threadKey });
      await tx
        .update(childWatches)
        .set({
          queueItemId: receipt.queueItemId,
          settled: false,
          dismissedAt: null,
          ...(current && replyRoute !== current.replyRoute ? { replyRoute } : {}),
        })
        .where(eq(childWatches.childSessionId, req.childSessionId));
    });

    watcher.arm({
      childSessionId: req.childSessionId,
      queueItemId: receipt.queueItemId,
      parentSessionId: ctx.parentSessionId,
      parentThreadId: watchRow.parentThreadId,
      actorUserId: ctx.actorUserId,
      orgId: watchRow.orgId,
    });

    return { queueItemId: receipt.queueItemId };
  };

  return async (req, ctx) => {
    const prev = chains.get(req.childSessionId) ?? Promise.resolve(null);
    const next = prev.catch(() => null).then(() => send(req, ctx));
    chains.set(req.childSessionId, next);
    try {
      return await next;
    } finally {
      if (chains.get(req.childSessionId) === next) chains.delete(req.childSessionId);
    }
  };
}

/**
 * Ceiling on the child result carried inline in a `child.settled` signal.
 *
 * The signal lands in the parent's thread, so the parent pays for it in
 * context on that turn and on every later turn until compaction. A child
 * that writes a large report would otherwise take that whole report into
 * its parent's context: a real child on 2026-08-06 produced over 100KB.
 *
 * For completed results this ceiling is safe because `child_read` can
 * fetch what it cuts — the text is a persisted thread entry. A settlement
 * ERROR is not a thread entry, so a truncated error's tail is gone; the
 * failure notice below says so instead of promising recovery. Do NOT
 * lower the ceiling, or truncate anywhere else, without keeping this
 * distinction — the parent has no other channel to its child.
 */
export const CHILD_RESULT_MAX_CHARS = 16_000;

/**
 * The child's result as the parent receives it, bounded.
 *
 * `childSessionId` is part of the signature rather than read from the watch
 * row because the truncation notice is useless without it: the parent needs
 * the id to pass to `child_read`.
 */
export function resultBody(
  result: SubmissionResult,
  childSessionId: string,
  continuationCheckpoint?: CompactionEntry,
): string {
  const isFailure = result.outcome === "failed" || result.outcome === "aborted";
  if (!isFailure && result.text === undefined) {
    return (
      `[No result text was captured for this ${result.outcome} child submission. ` +
      `Call child_read with child_session_id "${childSessionId}" to read the child's transcript.]`
    );
  }
  const full = isFailure
    ? (result.error ?? result.text ?? `child submission ${result.outcome}`)
    : (result.text ?? "");
  const checkpointHeader = continuationCheckpoint
    ? `\n\n## Continuation checkpoint (${continuationCheckpoint.id})\n`
    : "";
  const checkpointMaxChars = Math.floor(CHILD_RESULT_MAX_CHARS / 2);
  const checkpointSummary = continuationCheckpoint?.summary ?? "";
  const checkpoint = checkpointSummary.length <= checkpointMaxChars
    ? checkpointHeader + checkpointSummary
    : checkpointHeader + checkpointSummary.slice(0, checkpointMaxChars) +
      `\n\n[Checkpoint truncated. Call child_read with child_session_id ` +
      `"${childSessionId}" for the complete recovery state.]`;
  const available = Math.max(0, CHILD_RESULT_MAX_CHARS - checkpoint.length);
  if (full.length <= available) return full + checkpoint;

  const dropped = full.length - available;
  const prefix = full.slice(0, available);
  if (isFailure) {
    return (
      prefix +
      `\n\n[Truncated. ${dropped} more characters of this error were dropped and ` +
      `are not recoverable. Call child_read with child_session_id ` +
      `"${childSessionId}" to inspect the child's transcript instead.]` +
      checkpoint
    );
  }
  return (
    prefix +
    `\n\n[Truncated. ${dropped} more characters follow this point. To read the ` +
    `full result, call child_read with child_session_id "${childSessionId}".]`
  );
}
