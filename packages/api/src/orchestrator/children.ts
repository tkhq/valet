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
import { mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { and, count, eq, isNull, lte, notExists, sql } from "drizzle-orm";
import {
  PendingCapError,
  recordSandboxDestroyed,
  ValidationError as EngineValidationError,
  type ChildReader,
  type ChildSender,
  type ChildSpawner,
  type ChildStatusReader,
  type Principal,
  type SessionStore,
  type SpawnChildRequest,
  type SpawnChildResult,
  type SubmissionResult,
} from "@valet/engine";
import type { AppDb } from "../lib/drizzle.js";
import { agentSessions, childWatches, sessionRepos, type ChildWatchRow } from "../schema/index.js";
import type { EngineHost } from "../engine/host.js";
import { loadSessionMeta } from "../engine/session-meta.js";
import { computeTargetDirs } from "../engine/workspace-prep.js";
import type { RepoBinding } from "../wire/types.js";
import type { SourceService } from "../bakes/source-service.js";
import { admitSignal, writeDropLog, SignalEdgeDeniedError } from "./signals.js";
import { revokeSandboxTokens } from "../auth/sandbox-tokens.js";
import { startSweepTimer, type SweepTimer } from "../lib/sweep-timer.js";
import { writeHibernated } from "../engine/hibernation-hooks.js";
import { DEFAULT_ORG_ACTIVE_SESSION_CEILING, MAX_ACTIVE_CHILDREN_PER_ORCHESTRATOR } from "./limits.js";

/** Delay before the in-process retry of a retryable watcher failure (decision 20). */
const DEFAULT_WATCHER_RETRY_DELAY_MS = 30_000;
/** Max in-process attempts for a retryable failure before falling back to the boot `rearm()` backstop. */
const DEFAULT_WATCHER_MAX_ATTEMPTS = 3;
/** Cadence of the parked-sandbox retention sweep. Coarse on purpose — retention windows are hours. */
const DEFAULT_RETENTION_SWEEP_INTERVAL_MS = 15 * 60_000;

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

function watchRowToArgs(row: ChildWatchRow): ArmArgs {
  return {
    childSessionId: row.childSessionId,
    queueItemId: row.queueItemId,
    parentSessionId: row.parentSessionId,
    parentThreadId: row.parentThreadId,
    actorUserId: row.actorUserId,
    orgId: row.orgId,
  };
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
    ctx: { parentSessionId: string; parentThreadId: string; actorUserId: string; owner: Principal },
  ): Promise<SpawnChildResult> => {
    const parentData = await deps.engineStore.getSession(ctx.parentSessionId);
    if (!parentData) {
      throw new Error(`buildChildSpawner: parent session not found: ${ctx.parentSessionId}`);
    }
    const orgId = parentData.orgId;

    // Host policy for `req.repo` (`task` tool): normalize before anything is
    // created so a bad value costs nothing. The message is what the tool
    // surfaces verbatim.
    const binding = req.repo !== undefined ? parseTaskRepo(req.repo, req.branch) : undefined;
    if (req.repo !== undefined && binding === undefined) {
      throw new Error(
        `unrecognized repo '${req.repo}'. Pass owner/repo or a GitHub clone URL.`,
      );
    }

    await enforceLimits(deps.db, ctx.parentSessionId, orgId, deps.orgSessionCeiling);

    // A pre-assigned id (the security dispatch's cell-claim seam) wins so
    // the caller's durable claim row names the session this spawn builds.
    const childSessionId = req.sessionId ?? newChildSessionId();
    const workspace = join(deps.workspaceRoot ?? join(homedir(), ".valet", "children"), childSessionId);
    await mkdir(workspace, { recursive: true });

    if (binding) {
      // The binding row must land BEFORE the engine session is built —
      // `buildChildSession` loads meta from `session_repos` to wire clone
      // prep, and only the first build per cache lifetime decides that (see
      // `loadSessionMeta`'s module doc). A `childSessionFor` failure below
      // leaves this row orphaned for a session id that never runs; harmless.
      await deps.db.insert(sessionRepos).values({
        sessionId: childSessionId,
        host: binding.host ?? "github",
        fullName: binding.fullName,
        cloneUrl: binding.cloneUrl,
        ref: binding.ref ?? null,
        auth: binding.auth ?? "auto",
        position: 0,
        targetDir: computeTargetDirs([binding])[0] ?? null,
      });
      // Zero-config generation (spec decision 13), same fire-and-forget as
      // the REST create route — `ensureRepoSource` never throws.
      void deps.prebuildService.ensureRepoSource(orgId, {
        host: binding.host ?? "github",
        fullName: binding.fullName,
        cloneUrl: binding.cloneUrl,
      });
    }

    const childSession = await deps.engineHost.childSessionFor(childSessionId, {
      parentSessionId: ctx.parentSessionId,
      parentThreadId: ctx.parentThreadId,
      actorUserId: ctx.actorUserId,
      orgId,
      owner: ctx.owner,
      workspace,
      modelId: req.model,
      profile: req.profile,
      docker: req.docker,
    });

    const now = Date.now();
    await deps.db
      .insert(agentSessions)
      .values({
        id: childSessionId,
        userId: ctx.actorUserId,
        orgId,
        workspace,
        title: req.title ?? null,
        // Persisted so a post-restart rebuild through the generic
        // `sessionFor` (which reads the row) keeps the same sandbox shape.
        profile: req.profile ?? "headless",
        docker: req.docker === true,
        status: "active",
        ownerType: ctx.owner.type,
        ownerId: ctx.owner.id,
        createdAt: now,
        updatedAt: now,
      });

    const receipt = await childSession.prompt(req.prompt, {
      author: { id: ctx.actorUserId },
      // Per-turn role overlay (the security dispatch names the persona
      // role; the claimed child's build registered it in options.roles).
      ...(req.role !== undefined ? { role: req.role } : {}),
    });

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
      });

    watcher.arm({
      childSessionId,
      queueItemId: receipt.queueItemId,
      parentSessionId: ctx.parentSessionId,
      parentThreadId: ctx.parentThreadId,
      actorUserId: ctx.actorUserId,
      orgId,
    });

    return { childSessionId, queueItemId: receipt.queueItemId };
  };
}

interface ArmArgs {
  childSessionId: string;
  queueItemId: string;
  parentSessionId: string;
  parentThreadId: string;
  actorUserId: string;
  orgId: string;
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
 * Durable settlement watcher (decision 11). One instance per process, shared
 * across every spawned child; `rearm()` is called at boot next to
 * `restoreUnsettledSessions` so a process that died mid-child-run picks up
 * every still-unsettled watch and re-observes it.
 *
 * Double-fire safety: `arm` does NOT dedupe in-process — the correctness
 * mechanism is the engine's own dispatchId idempotent admission
 * (`settled:{childSessionId}:{queueItemId}` is deterministic), so calling
 * `arm` twice for the same row (concurrently, or across a `rearm()` that
 * races a still-running watch from before) still produces exactly one
 * persisted `child.settled` entry — the second `admitSignal` call resolves
 * to the same already-admitted queue item instead of creating a new one.
 *
 * Retryable failures (decision 20, see `classifyWatcherError`) are never
 * settled from this loop — a permanently-capped parent thread must not lose
 * the settlement. They get a bounded number of in-process delayed retries
 * (`retryDelayMs` apart); once that budget is exhausted the row is simply
 * left unsettled for the next boot's `rearm()` to pick back up with a fresh
 * budget. Only a genuinely permanent denial marks the row settled.
 */
export class ChildWatcher {
  private readonly retryDelayMs: number;
  private readonly maxAttempts: number;
  private retentionTimer: SweepTimer | undefined;

  constructor(private readonly deps: ChildrenDeps) {
    this.retryDelayMs = deps.retryDelayMs ?? DEFAULT_WATCHER_RETRY_DELAY_MS;
    this.maxAttempts = deps.maxRetryAttempts ?? DEFAULT_WATCHER_MAX_ATTEMPTS;
  }

  /** Fire-and-forget: arms `awaitResult` for one watch row. `attempt` is 1-based, reset to 1 on every `arm`/`rearm` call. */
  arm(watch: ArmArgs, attempt = 1): void {
    void this.run(watch, attempt).catch((err) => {
      console.error(`ChildWatcher: unexpected error watching ${watch.childSessionId}:`, err);
    });
  }

  private async run(watch: ArmArgs, attempt: number): Promise<void> {
    try {
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
      await this.markSettled(watch.childSessionId, watch.queueItemId);
      // No sandbox teardown here, deliberately: a permanent denial means
      // the parent never received the settlement, so keep the sandbox and
      // cached session around for debugging. The idle sweep owns the
      // eventual reclaim. Only the delivered-settlement path (attempt)
      // tears down eagerly.
    }
  }

  private async attempt(watch: ArmArgs): Promise<void> {
    const childData = await this.deps.engineStore.getSession(watch.childSessionId);
    if (!childData) throw new Error(`child session not found: ${watch.childSessionId}`);

    // Centralized meta assembly (repo bindings + git identity). The app row
    // supplies the persisted profile/docker: if this watcher wins the
    // post-restart first-touch race for a full/docker child, the rebuild
    // must keep the child's sandbox shape (services + docker caps) — a
    // partial meta here would cache a headless, docker-less session.
    const shapeRows = await this.deps.db
      .select({ profile: agentSessions.profile, docker: agentSessions.docker })
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
        ...(shapeRow ? { profile: shapeRow.profile, docker: shapeRow.docker } : {}),
      }),
    );
    // The spawner always prompts the child's default thread — see
    // `buildChildSpawner`'s `childSession.prompt(...)` call.
    const result = await childSession.thread().awaitResult(watch.queueItemId);

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
      .select({ queueItemId: childWatches.queueItemId, settled: childWatches.settled })
      .from(childWatches)
      .where(eq(childWatches.childSessionId, watch.childSessionId))
      .limit(1);
    const row = rows[0];
    if (!row || row.settled || row.queueItemId !== watch.queueItemId) return;

    // A superseded settlement is never reported — it is not a result. The
    // steer that superseded this item stamped its replacement on the queue
    // item; move the watch to the successor and watch that instead. This
    // self-heals a `child_send` that crashed between its steer admission
    // and its row update, and it follows a user's direct takeover of the
    // child (the parent then hears about the takeover's outcome). The
    // UPDATE is conditioned on the old queueItemId so a sender re-point
    // landing in between wins; double-arming the same successor is safe
    // (dispatchId idempotency + this guard).
    if (result.outcome === "superseded") {
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
      await this.deps.db
        .update(childWatches)
        .set({ queueItemId: successor, settled: false })
        .where(
          and(
            eq(childWatches.childSessionId, watch.childSessionId),
            eq(childWatches.queueItemId, watch.queueItemId),
          ),
        );
      this.arm({ ...watch, queueItemId: successor });
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

    await admitSignal(this.deps, {
      from: { sessionId: watch.childSessionId, owner: childData.owner },
      to: watch.parentSessionId,
      threadKey: watch.parentThreadId,
      content: {
        kind: "signal",
        signalType: "child.settled",
        body: resultBody(result, watch.childSessionId),
        attributes: {
          child_session_id: watch.childSessionId,
          outcome: result.outcome,
          ...(title !== undefined ? { title } : {}),
        },
      },
      dispatchId: `settled:${watch.childSessionId}:${watch.queueItemId}`,
    });

    await this.markSettled(watch.childSessionId, watch.queueItemId);
    await this.parkChildSandbox(watch.childSessionId);
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

      const retentionMs = this.deps.retentionMs ?? 0;
      const retainable = retentionMs > 0 && this.deps.engineHost.sandboxHibernationCapable();
      if (retainable && live.attachment.state === "suspended") {
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
      if (retainable && live.attachment.state === "ready") {
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
    if (retentionMs <= 0) return;
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
        const live = this.deps.engineHost.liveSession(row.childSessionId);
        if (live) {
          // Race rule (mirrors `maybeSuspendIdleSession`): re-check
          // immediately before the destroy — a submission admitted since
          // the check above wins and the reclaim waits for the next pass.
          const recheck = await this.deps.engineStore.listUnsettledSubmissions(row.childSessionId);
          if (recheck.length > 0) continue;
          await live.attachment.destroy("child_retention");
          this.deps.engineHost.evictCache(row.childSessionId);
        } else if (row.parkedSandboxId) {
          await this.deps.engineHost.destroySandbox(row.parkedSandboxId);
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

  /** Start the retention interval (no-op when retention is off). */
  startRetentionSweep(): void {
    if (this.retentionTimer || (this.deps.retentionMs ?? 0) <= 0) return;
    const intervalMs = this.deps.retentionSweepIntervalMs ?? DEFAULT_RETENTION_SWEEP_INTERVAL_MS;
    this.retentionTimer = startSweepTimer("ChildWatcher retention", intervalMs, () => this.sweepRetention());
  }

  stopRetentionSweep(): void {
    this.retentionTimer?.stop();
    this.retentionTimer = undefined;
  }

  /**
   * Re-arms every unsettled row (restart-survival, decision 11). Call at
   * boot alongside `restoreUnsettledSessions`. `awaitResult` is resumable by
   * construction — a row whose child already settled before the crash
   * resolves immediately once re-armed.
   */
  async rearm(): Promise<void> {
    const rows = await this.deps.db.select().from(childWatches).where(eq(childWatches.settled, false));
    for (const row of rows) this.arm(watchRowToArgs(row));
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
export function buildChildReader(deps: ChildrenDeps): ChildReader {
  return async (req, ctx) => {
    const rows = await deps.db
      .select({ childSessionId: childWatches.childSessionId })
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
    if (rows.length === 0) return null;

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
 * Builds the `ChildStatusReader` injected into every orchestrator's
 * `toolConfig.childStatusReader` — the backend of the engine's
 * `child_status` built-in. Authority is the same `child_watches` edge as
 * `buildChildReader`. The activity clock reads the engine store directly:
 * a status check must never wake the child (no sandbox token, no
 * reconcile, no engine rows for a deleted child).
 */
export function buildChildStatusReader(deps: ChildrenDeps): ChildStatusReader {
  return async (req, ctx) => {
    const rows = await deps.db
      .select({ settled: childWatches.settled })
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
    if (rows.length === 0) return null;

    const childRows = await deps.db
      .select({ status: agentSessions.status })
      .from(agentSessions)
      .where(eq(agentSessions.id, req.childSessionId))
      .limit(1);
    const child = childRows[0];
    // A deleted child answers the same null as a missing one.
    if (!child || child.status === "deleted") return null;

    const lastActivityAt = await deps.engineStore.latestActivityAt(req.childSessionId);
    return { settled: rows[0].settled === true, lastActivityAt };
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
 * `interrupt: true` admits with queue-mode steer, superseding the child's
 * in-flight work; the stale watcher on the superseded submission follows
 * the successor via the re-point guard in `ChildWatcher.attempt`.
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
    req: { childSessionId: string; message: string; interrupt?: boolean },
    ctx: { parentSessionId: string; parentThreadId: string; actorUserId: string },
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
    if (!watchRow) return null;

    const childRows = await deps.db
      .select({
        id: agentSessions.id,
        userId: agentSessions.userId,
        orgId: agentSessions.orgId,
        workspace: agentSessions.workspace,
        profile: agentSessions.profile,
        docker: agentSessions.docker,
        status: agentSessions.status,
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
    // profile/docker, so a post-restart rebuild keeps the child's sandbox
    // shape (services + docker caps) instead of silently going headless.
    const childSession = await deps.engineHost.sessionFor(
      req.childSessionId,
      await loadSessionMeta(deps.db, child),
    );
    // A child_send is USE: a parked (hibernated) child's row heals to
    // active even when the revived turn never touches the sandbox.
    await deps.engineHost.markSessionUsed(req.childSessionId);

    const receipt = await childSession.prompt(req.message, {
      author: { id: ctx.actorUserId },
      queueMode: req.interrupt ? "steer" : "followup",
    });

    // Re-point BEFORE arming: the fresh watcher must find the row already
    // tracking its submission, and the stale watcher (if any) must find it
    // no longer tracking the old one. Clearing `dismissedAt` keeps a
    // re-opened child visible in the orchestrator's child list — a hidden
    // row must never be running.
    await deps.db
      .update(childWatches)
      .set({
        queueItemId: receipt.queueItemId,
        settled: false,
        dismissedAt: null,
      })
      .where(eq(childWatches.childSessionId, req.childSessionId));

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
export function resultBody(result: SubmissionResult, childSessionId: string): string {
  const isFailure = result.outcome === "failed" || result.outcome === "aborted";
  // `text` is undefined when no terminal entry matched at read time — e.g.
  // the child's final message was compacted away between settlement and
  // this read. An empty body would leave the parent no lead to follow.
  if (!isFailure && result.text === undefined) {
    return (
      `[No result text was captured for this ${result.outcome} child submission. ` +
      `Call child_read with child_session_id "${childSessionId}" to read the child's transcript.]`
    );
  }
  const full = isFailure
    ? (result.error ?? result.text ?? `child submission ${result.outcome}`)
    : (result.text ?? "");
  if (full.length <= CHILD_RESULT_MAX_CHARS) return full;
  const dropped = full.length - CHILD_RESULT_MAX_CHARS;
  if (isFailure) {
    // The error string lives only in the settlement outcome, not in the
    // child's transcript — child_read cannot return the dropped tail.
    return (
      full.slice(0, CHILD_RESULT_MAX_CHARS) +
      `\n\n[Truncated. ${dropped} more characters of this error were dropped and ` +
      `are not recoverable. Call child_read with child_session_id ` +
      `"${childSessionId}" to inspect the child's transcript instead.]`
    );
  }
  return (
    full.slice(0, CHILD_RESULT_MAX_CHARS) +
    `\n\n[Truncated. ${dropped} more characters follow this point. To read the ` +
    `full result, call child_read with child_session_id "${childSessionId}".]`
  );
}
