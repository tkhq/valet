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
import { UNATTENDED_DELIVERY_KEY } from "@valet/shared";
import {
  settledSubmissionResult,
  TimeoutError,
  type ChildSpawner,
  type PluginChild,
  type PluginThreadRef,
  type PluginThreads,
  type Principal,
  type SessionStore,
  type SignalContent,
  type SubmissionResult,
  type ValetPlugin,
} from "@valet/engine";
import { eq, like, or } from "drizzle-orm";
import { ensureAssistantExecution } from "../assistants/service.js";
import type { EngineHost } from "../engine/host.js";
import type { AppDb } from "../lib/drizzle.js";
import { agentSessions, childWatches } from "../schema/index.js";

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
  /** Poll interval while a child runs. Tests shorten it. */
  pollMs?: number;
}

export interface PluginThreadsScope {
  plugin: ValetPlugin;
  orgId: string;
  owner: Principal;
  actorUserId: string;
}

const DEFAULT_POLL_MS = 2_000;
const DEFAULT_CHILD_TIMEOUT_MS = 30 * 60_000;
/** A merge follows the submission it joined; bound the chain like `Thread.awaitResult`. */
const MAX_MERGE_HOPS = 8;

/** The thread key a plugin key maps to: namespaced so plugins cannot collide with each other or with core keys. */
export function pluginThreadKey(plugin: string, key: string): string {
  return `plugin:${plugin}:${key}`;
}

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
  return `child_plg_${digest}`;
}

export function buildPluginThreads(deps: PluginThreadsDeps, scope: PluginThreadsScope): PluginThreads {
  const { plugin, orgId, owner, actorUserId } = scope;
  const prefix = pluginThreadKey(plugin.name, "");
  const meta = { actorUserId, orgId };

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
      const { thread } = await openThread(ref.key);
      const content: SignalContent = {
        kind: "signal",
        signalType: `plugin.${plugin.name}`,
        body,
        ...(opts.attributes !== undefined ? { attributes: opts.attributes } : {}),
      };
      // Nobody waits on a plugin post, so the turn refuses decision cards
      // instead of parking on one.
      const receipt = await thread.submitPrompt(content, {
        dispatchId: `plugin:${plugin.name}:${createHash("sha256").update(ref.key).digest("hex").slice(0, 12)}:${opts.dispatchId}`,
        metadata: { [UNATTENDED_DELIVERY_KEY]: true },
      });
      return { queueItemId: receipt.queueItemId };
    },

    async spawnChild(ref, req, opts) {
      owned(ref);
      if (req.role !== undefined && !(plugin.roles ?? []).some((r) => r.name === req.role)) {
        throw new Error(`Role ${req.role} is not declared by plugin ${plugin.name}. Add it to the plugin's roles.`);
      }
      if (req.ref !== undefined && req.repo === undefined) {
        throw new Error("A child ref needs a repo. Pass repo with ref.");
      }
      // The parent comes from the key, never from the caller's ids.
      const parent = await resolveThread(ref.key);
      const baseId = pluginChildSessionId(plugin.name, owner, ref.key, opts.dispatchId);
      const existing = await findChild(deps, baseId, parent.sessionId);
      if (existing) return existing;
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
        },
        {
          parentSessionId: parent.sessionId,
          parentThreadId: parent.threadId,
          actorUserId,
          owner,
          unattendedWorkflow: true,
          reportToParent: false,
        },
      );
      return { childSessionId: spawned.childSessionId, queueItemId: spawned.queueItemId };
    },

    async awaitChild(child, opts) {
      return awaitPluginChild(deps, child, opts);
    },
  };
}

/**
 * Wait for a child submission to settle, then read its result from the
 * store. Polls the queue item: the child may run in another process after a
 * restart, so there is no in-process event to wait on.
 */
export async function awaitPluginChild(
  deps: Pick<PluginThreadsDeps, "engineStore" | "pollMs">,
  child: PluginChild,
  opts: Parameters<PluginThreads["awaitChild"]>[1] = {},
): Promise<SubmissionResult> {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_CHILD_TIMEOUT_MS;
  const deadline = Date.now() + timeoutMs;
  let itemId = child.queueItemId;
  for (let hop = 0; hop <= MAX_MERGE_HOPS; hop++) {
    for (;;) {
      const item = await deps.engineStore.getQueueItem(child.childSessionId, itemId);
      if (!item) throw new Error(`Child submission ${itemId} is missing from session ${child.childSessionId}.`);
      if (item.status === "settled") {
        const outcome = item.outcome ?? { outcome: "failed" as const, error: "settled without a recorded outcome" };
        if (outcome.outcome === "merged" && item.mergedIntoItemId) {
          itemId = item.mergedIntoItemId;
          break;
        }
        return settledSubmissionResult(deps.engineStore, child.childSessionId, item, outcome, opts);
      }
      if (Date.now() >= deadline) {
        // The child keeps running; a later awaitChild with the same handle picks it up.
        throw new TimeoutError(itemId, timeoutMs);
      }
      await new Promise((resolve) => setTimeout(resolve, deps.pollMs ?? DEFAULT_POLL_MS));
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
