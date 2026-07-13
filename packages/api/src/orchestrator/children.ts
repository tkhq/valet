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
import { and, count, eq, ne } from "drizzle-orm";
import type {
  ChildSpawner,
  Principal,
  SessionStore,
  SpawnChildRequest,
  SpawnChildResult,
  SubmissionResult,
} from "@valet/engine";
import type { AppDb } from "../lib/drizzle.js";
import { agentSessions, childWatches, type ChildWatchRow } from "../schema/index.js";
import type { EngineHost } from "../engine/host.js";
import { admitSignal, writeDropLog } from "./signals.js";
import { MAX_ACTIVE_CHILDREN_PER_ORCHESTRATOR, ORG_ACTIVE_SESSION_CEILING } from "./limits.js";

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
    .where(and(eq(childWatches.parentSessionId, parentSessionId), eq(childWatches.settled, 0)))
    .all();

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
    .where(and(eq(childWatches.orgId, orgId), eq(childWatches.settled, 0)))
    .all();
  const [{ n: liveSessionsOrgWide }] = await db
    .select({ n: count() })
    .from(agentSessions)
    .where(and(eq(agentSessions.orgId, orgId), ne(agentSessions.status, "deleted")))
    .all();
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
      })
      .run();

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
        settled: 0,
        createdAt: now,
      })
      .run();

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
 */
export class ChildWatcher {
  constructor(private readonly deps: ChildrenDeps) {}

  /** Fire-and-forget: arms `awaitResult` for one watch row. */
  arm(watch: ArmArgs): void {
    void this.run(watch).catch((err) => {
      console.error(`ChildWatcher: unexpected error watching ${watch.childSessionId}:`, err);
    });
  }

  private async run(watch: ArmArgs): Promise<void> {
    try {
      await this.attempt(watch);
    } catch (err) {
      console.error(`ChildWatcher: first attempt failed for ${watch.childSessionId}, retrying once:`, err);
      try {
        await this.attempt(watch);
      } catch (err2) {
        // Permanent failure (e.g. the parent session/thread no longer
        // exists). Mark settled anyway so this row stops being re-armed on
        // every boot — an un-deliverable signal must not spin forever.
        console.error(`ChildWatcher: giving up on ${watch.childSessionId} after retry:`, err2);
        await writeDropLog(this.deps.db, {
          orgId: watch.orgId,
          reason: "edge_denied",
          conversationKey: watch.queueItemId,
          detail: `child watcher permanently failed to report settlement of ${watch.childSessionId}: ${String(err2)}`,
        });
        await this.markSettled(watch.childSessionId);
      }
    }
  }

  private async attempt(watch: ArmArgs): Promise<void> {
    const childData = await this.deps.engineStore.getSession(watch.childSessionId);
    if (!childData) throw new Error(`child session not found: ${watch.childSessionId}`);

    const childSession = await this.deps.engineHost.sessionFor(watch.childSessionId, {
      userId: childData.userId,
      orgId: childData.orgId,
      workspace: childData.workspace,
    });
    // The spawner always prompts the child's default thread — see
    // `buildChildSpawner`'s `childSession.prompt(...)` call.
    const result = await childSession.thread().awaitResult(watch.queueItemId);

    // Optional title attribute (decision 11): the spawn request's title is
    // mirrored onto the child's agent_sessions row — read it back from there
    // rather than widening child_watches with a redundant column.
    const appRow = await this.deps.db
      .select({ title: agentSessions.title })
      .from(agentSessions)
      .where(eq(agentSessions.id, watch.childSessionId))
      .get();
    const title = appRow?.title ?? undefined;

    await admitSignal(this.deps, {
      from: { sessionId: watch.childSessionId, owner: childData.owner },
      to: watch.parentSessionId,
      threadKey: watch.parentThreadId,
      content: {
        kind: "signal",
        signalType: "child.settled",
        body: resultBody(result),
        attributes: {
          child_session_id: watch.childSessionId,
          outcome: result.outcome,
          ...(title !== undefined ? { title } : {}),
        },
      },
      dispatchId: `settled:${watch.childSessionId}:${watch.queueItemId}`,
    });

    await this.markSettled(watch.childSessionId);
  }

  private async markSettled(childSessionId: string): Promise<void> {
    await this.deps.db
      .update(childWatches)
      .set({ settled: 1 })
      .where(eq(childWatches.childSessionId, childSessionId))
      .run();
  }

  /**
   * Re-arms every unsettled row (restart-survival, decision 11). Call at
   * boot alongside `restoreUnsettledSessions`. `awaitResult` is resumable by
   * construction — a row whose child already settled before the crash
   * resolves immediately once re-armed.
   */
  async rearm(): Promise<void> {
    const rows = await this.deps.db.select().from(childWatches).where(eq(childWatches.settled, 0)).all();
    for (const row of rows) this.arm(watchRowToArgs(row));
  }
}

function resultBody(result: SubmissionResult): string {
  if (result.outcome === "failed" || result.outcome === "aborted") {
    return result.error ?? result.text ?? `child submission ${result.outcome}`;
  }
  return result.text ?? "";
}
