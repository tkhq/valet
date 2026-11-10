/**
 * The host side of `PluginThreads` (`@valet/engine` plugin-agents.ts): a
 * plugin's keyed threads in the owner's assistant, and child sessions under
 * them.
 *
 * Threads go through `ensureAssistantExecution`, the path workflow thread
 * steps use, so a plugin thread is an ordinary assistant conversation. The
 * plugin never receives a `Session`; it holds `PluginThreadRef` values.
 */
import { createHash } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";
import { UNATTENDED_DELIVERY_KEY } from "@valet/shared";
import {
  settledSubmissionResult,
  TimeoutError,
  type ChildSpawner,
  type ChildStopper,
  type PluginChild,
  type PluginThreadRef,
  type PluginThreads,
  type Principal,
  type SessionStore,
  type SignalContent,
  type SubmissionResult,
  type ValetPlugin,
} from "@valet/engine";
import type { TSchema } from "typebox";
import { and, eq, inArray, like, or, sql } from "drizzle-orm";
import { ensureAssistantExecution } from "../assistants/service.js";
import type { EngineHost } from "../engine/host.js";
import type { AppDb } from "../lib/drizzle.js";
import { agentSessions, childWatches, eventDeliveries } from "../schema/index.js";
import { PLUGIN_CHILD_SESSION_PREFIX, pluginThreadKey } from "./plugin-thread-key.js";

export { pluginThreadKey };

export interface PluginThreadsDeps {
  db: AppDb;
  /** Opens plugin threads in the owner's assistant. Needed by `ensure` and `post`. */
  engineHost?: EngineHost;
  /**
   * Resolves a plugin thread key to its session and thread ids. Absent: the
   * host opens the thread through `engineHost`. Tests pass a fixed resolver.
   */
  resolveThread?: (key: string) => Promise<{ sessionId: string; threadId: string }>;
  engineStore: SessionStore;
  childSpawner: ChildSpawner;
  childStopper: ChildStopper;
  /** Poll interval while a child runs. Tests shorten it. */
  pollMs?: number;
}

export interface PluginThreadsScope {
  plugin: ValetPlugin;
  orgId: string;
  owner: Principal;
  actorUserId: string;
  /**
   * The event delivery this run handles. Children it starts or reuses are
   * recorded against it (`child_watches.plugin_delivery_id`), so cancelling
   * the delivery stops them (`stopPluginDeliveryChildren`).
   */
  deliveryId: string;
  /** The handler run's signal. When it aborts, `awaitReply` and `awaitChild` end with an `AbortError`. */
  signal?: AbortSignal;
  /**
   * Aborts when the run is cancelled for good (its line turned off, or a
   * newer event superseded it). The dispatcher stops the delivery's
   * children then; this run starts no more, and stops a child whose spawn
   * lands after the cancel. Shutdown does not abort it: a later process
   * resumes the run and finds the same children by dispatch id.
   */
  cancelChildren?: AbortSignal;
}

const DEFAULT_POLL_MS = 2_000;
const DEFAULT_CHILD_TIMEOUT_MS = 30 * 60_000;
/** A merge follows the submission it joined; bound the chain like `Thread.awaitResult`. */
const MAX_MERGE_HOPS = 8;

/**
 * A child session id fixed by (plugin, owner, thread, dispatch): a retry of
 * the same dispatch finds the child the first call started instead of
 * starting another. The owner is part of it, so two workspaces handling the
 * same event never share a child.
 */
export function pluginChildSessionId(plugin: string, owner: Principal, threadKey: string, dispatchId: string): string {
  const digest = createHash("sha256")
    .update(`${plugin}\n${owner.type}:${owner.id}\n${threadKey}\n${dispatchId}`)
    .digest("hex")
    .slice(0, 32);
  return `${PLUGIN_CHILD_SESSION_PREFIX}${digest}`;
}

export function buildPluginThreads(deps: PluginThreadsDeps, scope: PluginThreadsScope): PluginThreads {
  const { plugin, orgId, owner, actorUserId } = scope;
  const prefix = pluginThreadKey(plugin.name, "");
  const meta = { actorUserId, orgId };

  /** A child whose spawn landed after the run was cancelled: stop it too. */
  const stopIfCancelled = (child: PluginChild, parent: { sessionId: string; threadId: string }): PluginChild => {
    if (scope.cancelChildren?.aborted) {
      void deps.childStopper({ childSessionId: child.childSessionId }, { parentSessionId: parent.sessionId, parentThreadId: parent.threadId })
        .catch((err) => console.error(`plugin ${plugin.name}: stopping child ${child.childSessionId} failed:`, err));
    }
    return child;
  };

  const openThread = async (key: string, title?: string) => {
    if (!deps.engineHost) throw new Error("Plugin threads need the engine host. Wire engineHost into the plugin threads deps.");
    // Isolated: each plugin thread runs in its own execution session, so its
    // children, queue and cost stay apart from the owner's conversations.
    const { session } = await ensureAssistantExecution(
      { db: deps.db, engineHost: deps.engineHost },
      owner,
      meta,
      key,
      { isolated: true, ...(title !== undefined ? { title } : {}) },
    );
    const thread = await session.createThread(key, title !== undefined ? { title } : undefined);
    return { session, thread };
  };
  const resolveThread = async (key: string): Promise<{ sessionId: string; threadId: string }> => {
    if (deps.resolveThread) return deps.resolveThread(key);
    const { session, thread } = await openThread(key);
    return { sessionId: session.id, threadId: thread.id };
  };

  /** Whether `threadId` in `sessionId` is one of this plugin's threads in this owner's workspace. */
  const ownsThread = async (sessionId: string, threadId: string): Promise<boolean> => {
    const [row] = await deps.db
      .select({ id: agentSessions.id })
      .from(agentSessions)
      .where(and(eq(agentSessions.id, sessionId), eq(agentSessions.orgId, orgId), eq(agentSessions.ownerType, owner.type), eq(agentSessions.ownerId, owner.id)))
      .limit(1);
    if (!row) return false;
    const thread = await deps.engineStore.getThread(sessionId, threadId);
    return thread?.key.startsWith(prefix) ?? false;
  };
  /** The watch row of a child under one of this plugin's threads for this owner, or a refusal. */
  const ownedChild = async (child: PluginChild): Promise<{ parentSessionId: string; parentThreadId: string }> => {
    const [watch] = await deps.db
      .select({ parentSessionId: childWatches.parentSessionId, parentThreadId: childWatches.parentThreadId })
      .from(childWatches)
      .where(eq(childWatches.childSessionId, child.childSessionId))
      .limit(1);
    if (!watch || !(await ownsThread(watch.parentSessionId, watch.parentThreadId))) {
      throw new Error(`Child ${child.childSessionId} was not started by plugin ${plugin.name} for this workspace. Use only children from threads.spawnChild.`);
    }
    return watch;
  };

  const owned = (ref: PluginThreadRef): void => {
    if (!ref.key.startsWith(prefix)) {
      throw new Error(`Thread ${ref.key} does not belong to plugin ${plugin.name}. Use a thread from threads.ensure.`);
    }
  };

  return {
    async ensure(key, opts) {
      if (key.trim() === "") throw new Error("A plugin thread key must not be empty.");
      const threadKey = pluginThreadKey(plugin.name, key);
      const { session, thread } = await openThread(threadKey, opts?.title);
      return { sessionId: session.id, threadId: thread.id, key: threadKey };
    },

    async post(ref, body, opts) {
      owned(ref);
      const { session, thread } = await openThread(ref.key);
      const content: SignalContent = {
        kind: "signal",
        signalType: `plugin.${plugin.name}`,
        body: opts.resultSchema ? `${body}\n\n${answerFormat(opts.resultSchema)}` : body,
        ...(opts.attributes !== undefined ? { attributes: opts.attributes } : {}),
      };
      // Nobody waits on a plugin post, so the turn refuses decision cards
      // instead of parking on one.
      const receipt = await thread.submitPrompt(content, {
        dispatchId: `plugin:${plugin.name}:${createHash("sha256").update(ref.key).digest("hex").slice(0, 12)}:${opts.dispatchId}`,
        metadata: { [UNATTENDED_DELIVERY_KEY]: true },
      });
      return { sessionId: session.id, threadId: thread.id, queueItemId: receipt.queueItemId };
    },

    async record(ref, body, opts) {
      owned(ref);
      const { thread } = await openThread(ref.key);
      // No model call: the message is a record, read on the next turn.
      await thread.recordSignal(
        { kind: "signal", signalType: `plugin.${plugin.name}`, body, ...(opts.attributes !== undefined ? { attributes: opts.attributes } : {}) },
        { dispatchId: `plugin:${plugin.name}:${createHash("sha256").update(ref.key).digest("hex").slice(0, 12)}:${opts.dispatchId}` },
      );
    },

    async awaitReply(reply, opts) {
      // The host checks the ids it is handed: the reply must sit in one of
      // this plugin's threads in this owner's workspace.
      const notOurs = new Error(`Reply ${reply.queueItemId} is not in a thread of plugin ${plugin.name} for this workspace. Use the reply that threads.post returned.`);
      if (!(await ownsThread(reply.sessionId, reply.threadId))) throw notOurs;
      const item = await deps.engineStore.getQueueItem(reply.sessionId, reply.queueItemId);
      if (item?.threadId !== reply.threadId) throw notOurs;
      return awaitSubmission(deps, { sessionId: reply.sessionId, queueItemId: reply.queueItemId }, { ...opts, signal: scope.signal });
    },

    async spawnChild(ref, req, opts) {
      owned(ref);
      if (req.role !== undefined && !(plugin.roles ?? []).some((r) => r.name === req.role)) {
        throw new Error(`Role ${req.role} is not declared by plugin ${plugin.name}. Add it to the plugin's roles.`);
      }
      if (req.ref !== undefined && req.repo === undefined) {
        throw new Error("A child ref needs a repo. Pass repo with ref.");
      }
      if (scope.cancelChildren?.aborted) throw new DOMException("This plugin run was cancelled. Start no more children.", "AbortError");
      // The parent comes from the key, never from the caller's ids.
      const parent = await resolveThread(ref.key);
      const baseId = pluginChildSessionId(plugin.name, owner, ref.key, opts.dispatchId);
      const existing = await findChild(deps, baseId, parent.sessionId);
      if (existing) {
        // This run reuses the child, so it now belongs to this delivery:
        // cancelling the delivery that first started it must not stop it.
        // Only a live delivery takes a child over. A run superseded in
        // another process may not know yet; it must not take the child back
        // from the run that superseded it.
        const taken = await deps.db.update(childWatches).set({ pluginDeliveryId: scope.deliveryId })
          .where(and(
            eq(childWatches.childSessionId, existing.childSessionId),
            sql`EXISTS (SELECT 1 FROM ${eventDeliveries} WHERE ${eventDeliveries.id} = ${scope.deliveryId} AND ${eventDeliveries.status} IN ('pending', 'failed'))`,
          ))
          .returning({ id: childWatches.childSessionId });
        if (taken.length === 0) throw new DOMException("This plugin run's delivery was cancelled. Start no more children.", "AbortError");
        return stopIfCancelled(existing, parent);
      }
      const childSessionId = await freeChildId(deps, baseId);

      const spawned = await deps.childSpawner(
        {
          prompt: req.prompt,
          sessionId: childSessionId,
          // A plugin child reads untrusted input (PR text, issue bodies), so
          // it gets no integration actions unless the plugin asks for them.
          toolScope: req.toolScope ?? { actions: [] },
          ...(req.title !== undefined ? { title: req.title } : {}),
          ...(req.role !== undefined ? { role: req.role } : {}),
          ...(req.model !== undefined ? { model: req.model } : {}),
          ...(req.repo !== undefined ? { repo: req.repo } : {}),
          ...(req.ref !== undefined ? { branch: req.ref } : {}),
          ...(req.profile !== undefined ? { profile: req.profile } : {}),
          ...(req.docker !== undefined ? { docker: req.docker } : {}),
          ...(req.gitAccess !== undefined ? { gitAccess: req.gitAccess } : {}),
          ...(req.resources !== undefined ? { resources: req.resources } : {}),
          ...(req.prepare !== undefined ? { prepare: req.prepare } : {}),
        },
        {
          parentSessionId: parent.sessionId,
          parentThreadId: parent.threadId,
          actorUserId,
          owner,
          unattendedWorkflow: true,
          reportToParent: false,
          pluginDeliveryId: scope.deliveryId,
          ...(scope.cancelChildren !== undefined ? { cancel: scope.cancelChildren } : {}),
        },
      );
      return stopIfCancelled({ childSessionId: spawned.childSessionId, queueItemId: spawned.queueItemId }, parent);
    },

    async awaitChild(child, opts) {
      await ownedChild(child);
      return awaitSubmission(deps, { sessionId: child.childSessionId, queueItemId: child.queueItemId }, { ...opts, signal: scope.signal });
    },

    async stopChild(child) {
      // Whichever run started it, the child must hang off one of this
      // plugin's threads in this owner's workspace.
      const watch = await ownedChild(child);
      const result = await deps.childStopper({ childSessionId: child.childSessionId }, watch);
      if (!result) throw new Error(`Child ${child.childSessionId} was not started by plugin ${plugin.name} for this workspace. Use only children from threads.spawnChild.`);
      return result;
    },
  };
}

/**
 * Stop the unsettled children recorded against these plugin deliveries.
 * The dispatcher calls it when it cancels deliveries for good (line off,
 * superseded), whether or not a run for them is live in this process.
 */
export async function stopPluginDeliveryChildren(
  deps: Pick<PluginThreadsDeps, "db" | "childStopper">,
  deliveryIds: readonly string[],
): Promise<number> {
  if (deliveryIds.length === 0) return 0;
  const rows = await deps.db
    .select({ childSessionId: childWatches.childSessionId, parentSessionId: childWatches.parentSessionId, parentThreadId: childWatches.parentThreadId })
    .from(childWatches)
    .where(and(inArray(childWatches.pluginDeliveryId, [...deliveryIds]), eq(childWatches.settled, false)));
  let stopped = 0;
  for (const row of rows) {
    try {
      stopped += (await deps.childStopper({ childSessionId: row.childSessionId }, row))?.stopped ?? 0;
    } catch (err) {
      console.error(`plugin child ${row.childSessionId}: stop failed:`, err);
    }
  }
  return stopped;
}

/**
 * Wait for a submission (a child's task, or the assistant's answer to a
 * post) to settle, then read its result from the store. Polls the queue
 * item: the work may run in another process after a restart, so there is no
 * in-process event to wait on.
 */
export async function awaitSubmission(
  deps: Pick<PluginThreadsDeps, "engineStore" | "pollMs">,
  target: { sessionId: string; queueItemId: string },
  opts: Parameters<PluginThreads["awaitChild"]>[1] & { signal?: AbortSignal | undefined } = {},
): Promise<SubmissionResult> {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_CHILD_TIMEOUT_MS;
  const deadline = Date.now() + timeoutMs;
  let itemId = target.queueItemId;
  for (let hop = 0; hop <= MAX_MERGE_HOPS; hop++) {
    for (;;) {
      if (opts.signal?.aborted) throw new DOMException("The plugin run was stopped.", "AbortError");
      const item = await deps.engineStore.getQueueItem(target.sessionId, itemId);
      if (!item) throw new Error(`Submission ${itemId} is missing from session ${target.sessionId}.`);
      if (item.status === "settled") {
        const outcome = item.outcome ?? { outcome: "failed" as const, error: "settled without a recorded outcome" };
        if (outcome.outcome === "merged" && item.mergedIntoItemId) {
          itemId = item.mergedIntoItemId;
          break;
        }
        return settledSubmissionResult(deps.engineStore, target.sessionId, item, outcome, opts);
      }
      if (Date.now() >= deadline) {
        // The work keeps running; a later wait with the same handle picks it up.
        throw new TimeoutError(itemId, timeoutMs);
      }
      // Rejects with an AbortError when the handler run stops.
      await sleep(deps.pollMs ?? DEFAULT_POLL_MS, undefined, opts.signal ? { signal: opts.signal } : undefined);
    }
  }
  return { queueItemId: itemId, outcome: "failed", error: `merge chain longer than ${MAX_MERGE_HOPS} hops` };
}

/**
 * The child a dispatch already started: the base id, or a replacement id
 * from an earlier orphan recovery. A child of another parent is refused.
 */
async function findChild(deps: PluginThreadsDeps, baseId: string, parentSessionId: string): Promise<PluginChild | undefined> {
  const rows = await deps.db
    .select({ childSessionId: childWatches.childSessionId, queueItemId: childWatches.queueItemId, parentSessionId: childWatches.parentSessionId })
    .from(childWatches)
    .where(or(eq(childWatches.childSessionId, baseId), like(childWatches.childSessionId, `${baseId}-r%`)));
  const row = rows.sort((a, b) => b.childSessionId.localeCompare(a.childSessionId))[0];
  if (!row) return undefined;
  if (row.parentSessionId !== parentSessionId) {
    throw new Error(`Child ${row.childSessionId} belongs to another thread. Use a dispatch id unique to this thread.`);
  }
  return { childSessionId: row.childSessionId, queueItemId: row.queueItemId };
}

/** Replacement ids tried after an orphaned spawn. */
const MAX_ORPHAN_RETRIES = 5;

/**
 * `baseId`, or the next free replacement when a crash left a session for it
 * without a watch row. The spawner writes the session first and the watch
 * last, so an orphan means the earlier process died in between. The orphan
 * is logged, not deleted: the reconcile sweep owns session cleanup.
 */
async function freeChildId(deps: PluginThreadsDeps, baseId: string): Promise<string> {
  for (let n = 0; n <= MAX_ORPHAN_RETRIES; n++) {
    const id = n === 0 ? baseId : `${baseId}-r${n}`;
    const [row] = await deps.db.select({ id: agentSessions.id }).from(agentSessions).where(eq(agentSessions.id, id)).limit(1);
    if (!row && !(await deps.engineStore.getSession(id))) return id;
    console.warn("plugin_child_orphan", { childSessionId: id });
  }
  throw new Error(`Child ${baseId} failed to start ${MAX_ORPHAN_RETRIES + 1} times. Check the orphaned child sessions in the logs.`);
}

/** The instruction a typed `post` appends, so the assistant ends with JSON the schema accepts. */
export function answerFormat(schema: TSchema): string {
  return [
    "End your answer with one ```json code block that matches this JSON Schema.",
    "```json",
    JSON.stringify(schema, null, 2),
    "```",
  ].join("\n");
}
