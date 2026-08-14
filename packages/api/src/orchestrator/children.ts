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
import { and, count, eq, ne, notExists, sql } from "drizzle-orm";
import {
  PendingCapError,
  ValidationError as EngineValidationError,
  type ChildReader,
  type ChildSpawner,
  type Principal,
  type SessionStore,
  type SpawnChildRequest,
  type SpawnChildResult,
  type SubmissionResult,
} from "@valet/engine";
import type { AppDb } from "../lib/drizzle.js";
import { agentSessions, childWatches, type ChildWatchRow } from "../schema/index.js";
import type { EngineHost } from "../engine/host.js";
import { loadSessionMeta } from "../engine/session-meta.js";
import { admitSignal, writeDropLog, SignalEdgeDeniedError } from "./signals.js";
import { MAX_ACTIVE_CHILDREN_PER_ORCHESTRATOR, ORG_ACTIVE_SESSION_CEILING } from "./limits.js";

/** Delay before the in-process retry of a retryable watcher failure (decision 20). */
const DEFAULT_WATCHER_RETRY_DELAY_MS = 30_000;
/** Max in-process attempts for a retryable failure before falling back to the boot `rearm()` backstop. */
const DEFAULT_WATCHER_MAX_ATTEMPTS = 3;

export interface ChildrenDeps {
  db: AppDb;
  engineHost: EngineHost;
  engineStore: SessionStore;
  /**
   * Directory under which per-child workspaces are created
   * (`{workspaceRoot}/{childSessionId}`, mkdir'd at spawn). Defaults to
   * `~/.valet/children`; tests point it at a tmp dir.
   */
  workspaceRoot?: string;
  /** Override for `ChildWatcher`'s retryable-failure backoff. Tests only. */
  retryDelayMs?: number;
  /** Override for `ChildWatcher`'s in-process retry budget. Tests only. */
  maxRetryAttempts?: number;
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
 * Enforces decision-21 limits BEFORE anything is created. Throws
 * `ChildLimitError` (and drop-logs) on violation.
 */
async function enforceLimits(db: AppDb, parentSessionId: string, orgId: string): Promise<void> {
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
  const [{ n: liveSessionsOrgWide }] = await db
    .select({ n: count() })
    .from(agentSessions)
    .where(
      and(
        eq(agentSessions.orgId, orgId),
        ne(agentSessions.status, "deleted"),
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
  if (total >= ORG_ACTIVE_SESSION_CEILING) {
    const message = `[org_ceiling] org ${orgId} is at ${total} active sessions (unsettled children + live sessions), limit ${ORG_ACTIVE_SESSION_CEILING}`;
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

    await enforceLimits(deps.db, ctx.parentSessionId, orgId);

    const childSessionId = newChildSessionId();
    const workspace = join(deps.workspaceRoot ?? join(homedir(), ".valet", "children"), childSessionId);
    await mkdir(workspace, { recursive: true });

    const childSession = await deps.engineHost.childSessionFor(childSessionId, {
      parentSessionId: ctx.parentSessionId,
      parentThreadId: ctx.parentThreadId,
      actorUserId: ctx.actorUserId,
      orgId,
      owner: ctx.owner,
      workspace,
      modelId: req.model,
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
        status: "active",
        ownerType: ctx.owner.type,
        ownerId: ctx.owner.id,
        createdAt: now,
        updatedAt: now,
      });

    const receipt = await childSession.prompt(req.prompt, {
      author: { id: ctx.actorUserId },
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
      await this.markSettled(watch.childSessionId);
      await this.teardownChildSandbox(watch.childSessionId);
    }
  }

  private async attempt(watch: ArmArgs): Promise<void> {
    const childData = await this.deps.engineStore.getSession(watch.childSessionId);
    if (!childData) throw new Error(`child session not found: ${watch.childSessionId}`);

    // Centralized meta assembly (repo bindings + git identity). A child that
    // was spawned with repo bindings gets them prepped here too; one without
    // returns empty bindings, and `profile` stays unset (headless) exactly as
    // this watcher path did before — see `loadSessionMeta`.
    const childSession = await this.deps.engineHost.sessionFor(
      watch.childSessionId,
      await loadSessionMeta(this.deps.db, {
        id: watch.childSessionId,
        userId: childData.userId,
        orgId: childData.orgId,
        workspace: childData.workspace,
      }),
    );
    // The spawner always prompts the child's default thread — see
    // `buildChildSpawner`'s `childSession.prompt(...)` call.
    const result = await childSession.thread().awaitResult(watch.queueItemId);

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

    await this.markSettled(watch.childSessionId);
    await this.teardownChildSandbox(watch.childSessionId);
  }

  private async markSettled(childSessionId: string): Promise<void> {
    await this.deps.db
      .update(childWatches)
      .set({ settled: true })
      .where(eq(childWatches.childSessionId, childSessionId));
  }

  /**
   * Reclaim a settled child's compute. The orchestrator has no tool to
   * message an existing child (`task` spawns, `child_read` reads), so once
   * the settlement signal is admitted the sandbox is dead weight — destroy
   * it now instead of waiting for the idle sweep (which only truly
   * hibernates on the kubernetes backend). Session data stays: `child_read`
   * and the Sessions page keep working, and a user message to the child
   * cold-starts a fresh sandbox. Best-effort — a teardown failure never
   * un-settles the watch.
   */
  private async teardownChildSandbox(childSessionId: string): Promise<void> {
    try {
      const live = this.deps.engineHost.liveSession(childSessionId);
      if (!live) return;
      await live.attachment.destroy();
      this.deps.engineHost.evictCache(childSessionId);
    } catch (err) {
      console.error(`ChildWatcher: sandbox teardown failed for settled child ${childSessionId}:`, err);
    }
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
