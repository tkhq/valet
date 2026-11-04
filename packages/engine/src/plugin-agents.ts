/**
 * Plugin agents: how a plugin runs AI work on Valet's own primitives.
 *
 * A plugin does not build sessions or call models. It asks the host for a
 * keyed thread in the owner's assistant (one per subject, such as a pull
 * request), and starts child sessions under that thread for focused work.
 * People see the thread and its children like any other assistant work, and
 * the children's cost rolls up to the thread. The plugin keeps only pointers
 * between runs (a commit sha, comment ids) in its plugin store; the thread
 * and the provider hold the content.
 *
 * See docs/specs/2026-10-07-plugin-http-interfaces-design.md for the host
 * capability rules these follow: plugins get narrow ports, never `AppDb`.
 */
import type { TSchema } from "typebox";
import type { NormalizedEvent } from "./valet-plugin.js";
import type { ToolScope } from "@valet/shared";
import type { Principal, ScopedPluginStore, SubmissionResult } from "./types.js";

/** A plugin's thread in the owner's assistant. */
export interface PluginThreadRef {
  sessionId: string;
  threadId: string;
  /** The thread key, `plugin:<plugin>:<key>`. */
  key: string;
}

/** One child session for focused work under a plugin thread. */
export interface PluginChildRequest {
  prompt: string;
  title?: string;
  /** A role from this plugin's `roles`. */
  role?: string;
  /** provider/model. Absent uses the owner's default for children. */
  model?: string;
  /** Narrows the child's tools; the parent thread's scope is the ceiling. */
  toolScope?: ToolScope;
  /** `owner/repo` or a GitHub clone URL, checked out in the child's sandbox. */
  repo?: string;
  /** Branch, tag or commit to check out. Needs `repo`. */
  ref?: string;
}

export interface PluginChild {
  childSessionId: string;
  queueItemId: string;
}

export interface PluginThreads {
  /**
   * The plugin's thread for `key` in the owner's assistant, created on first
   * use. The same key always returns the same thread.
   */
  ensure(key: string, opts?: { title?: string }): Promise<PluginThreadRef>;
  /**
   * Post a message into the thread. The assistant reads it and answers in
   * the thread, so a person can continue the conversation there. Idempotent
   * per `dispatchId`.
   */
  post(
    thread: PluginThreadRef,
    body: string,
    opts: { dispatchId: string; attributes?: Record<string, string> },
  ): Promise<{ queueItemId: string }>;
  /**
   * Start a child session under the thread. Its result does not wake the
   * thread: the plugin reads it with `awaitChild`. Idempotent per
   * `dispatchId`: a retry returns the child the first call started.
   */
  spawnChild(thread: PluginThreadRef, req: PluginChildRequest, opts: { dispatchId: string }): Promise<PluginChild>;
  /**
   * Wait for the child's submission to settle. With `resultSchema`, the
   * child's final message is parsed as JSON and validated into `output`.
   */
  awaitChild(child: PluginChild, opts?: { resultSchema?: TSchema; timeoutMs?: number }): Promise<SubmissionResult>;
}

/** What a plugin event handler receives besides the event. */
export interface PluginEventContext {
  orgId: string;
  /** The subscription owner: the workspace the handler acts for. */
  owner: Principal;
  /** The identity the handler acts as: the owner's user id, or `team:<id>` for a team. */
  actorUserId: string;
  threads: PluginThreads;
  /** This plugin's store, scoped to `owner`. Keep pointers here, not content. */
  store: ScopedPluginStore;
  /**
   * The org's app credential for one of this plugin's services, or null when
   * it is not connected. The service must be the plugin's own name or one it
   * declares a credential for. `owner` picks the installation for a provider
   * with one per account (GitHub: the repository owner's login).
   */
  appToken(service: string, scope?: { owner?: string }): Promise<string | null>;
  signal: AbortSignal;
}

/** An event delivered to a plugin handler, with its stored id. */
export interface PluginEvent extends NormalizedEvent {
  id: string;
}

/**
 * A plugin's handler for events. A subscription with target
 * `{ kind: "plugin", plugin, handler }` routes matching events here; the
 * host owns matching, delivery records and retries. A throw marks the
 * delivery failed.
 */
export interface PluginEventHandler {
  /** Unique within the plugin, e.g. `review-pull-request`. */
  id: string;
  /** One sentence for the subscription UI. */
  description: string;
  /** Event keys this handler accepts. A trailing `.*` accepts a family. */
  events: string[];
  handle(event: PluginEvent, ctx: PluginEventContext): Promise<void>;
}

/** Whether `key` is one of `patterns` (exact, or `prefix.*`). */
export function pluginHandlerAccepts(handler: Pick<PluginEventHandler, "events">, key: string): boolean {
  return handler.events.some((p) => (p.endsWith(".*") ? key.startsWith(p.slice(0, -1)) : p === key));
}
