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
import { eq } from "drizzle-orm";
import { ensureAssistantExecution } from "../assistants/service.js";
import type { EngineHost } from "../engine/host.js";
import type { AppDb } from "../lib/drizzle.js";
import { childWatches } from "../schema/index.js";

export interface PluginThreadsDeps {
  db: AppDb;
  engineHost: EngineHost;
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
 * A child session id fixed by (plugin, thread, dispatch): a retry of the
 * same dispatch finds the child the first call started instead of
 * starting another.
 */
export function pluginChildSessionId(plugin: string, threadKey: string, dispatchId: string): string {
  const digest = createHash("sha256").update(`${plugin}\n${threadKey}\n${dispatchId}`).digest("hex").slice(0, 32);
  return `child_plg_${digest}`;
}

export function buildPluginThreads(deps: PluginThreadsDeps, scope: PluginThreadsScope): PluginThreads {
  const { plugin, orgId, owner, actorUserId } = scope;
  const prefix = pluginThreadKey(plugin.name, "");
  const meta = { actorUserId, orgId };

  const openThread = async (key: string, title?: string) => {
    const { session } = await ensureAssistantExecution(
      { db: deps.db, engineHost: deps.engineHost },
      owner,
      meta,
      key,
      title !== undefined ? { title } : undefined,
    );
    const thread = await session.createThread(key, title !== undefined ? { title } : undefined);
    return { session, thread };
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
        dispatchId: `plugin:${plugin.name}:${opts.dispatchId}`,
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
      const childSessionId = pluginChildSessionId(plugin.name, ref.key, opts.dispatchId);
      const [existing] = await deps.db
        .select({ queueItemId: childWatches.queueItemId })
        .from(childWatches)
        .where(eq(childWatches.childSessionId, childSessionId))
        .limit(1);
      if (existing) return { childSessionId, queueItemId: existing.queueItemId };

      const spawned = await deps.childSpawner(
        {
          prompt: req.prompt,
          sessionId: childSessionId,
          ...(req.title !== undefined ? { title: req.title } : {}),
          ...(req.role !== undefined ? { role: req.role } : {}),
          ...(req.model !== undefined ? { model: req.model } : {}),
          ...(req.toolScope !== undefined ? { toolScope: req.toolScope } : {}),
          ...(req.repo !== undefined ? { repo: req.repo } : {}),
          ...(req.ref !== undefined ? { branch: req.ref } : {}),
        },
        {
          parentSessionId: ref.sessionId,
          parentThreadId: ref.threadId,
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
