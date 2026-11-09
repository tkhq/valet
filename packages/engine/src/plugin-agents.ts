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
import type { Principal, SandboxResources, ScopedPluginStore, SubmissionResult } from "./types.js";

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
  /** Sandbox profile: "headless" (default) for agent work, "full" for interactive services. */
  profile?: "headless" | "full";
  /** A Docker daemon in the child's sandbox, to run the project's own containers. */
  docker?: boolean;
  /**
   * `read`: the child's git credential can clone and fetch, never push.
   * Use it for a child that only reads a repository, such as a reviewer.
   */
  gitAccess?: "read";
  /** CPU, memory and scratch for this child only. */
  resources?: Pick<SandboxResources, "cpu" | "memory" | "scratch">;
}

export interface PluginChild {
  childSessionId: string;
  queueItemId: string;
}

/** A message `post` put into a plugin thread, to wait on with `awaitReply`. */
export interface PluginReply {
  sessionId: string;
  threadId: string;
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
    opts: { dispatchId: string; attributes?: Record<string, string>; resultSchema?: TSchema },
  ): Promise<PluginReply>;
  /**
   * Add a message to the thread without a model call. People read it in
   * the thread, and the assistant reads it on its next turn. Idempotent
   * per `dispatchId`. Use it for a record, such as a review nobody posted.
   */
  record(thread: PluginThreadRef, body: string, opts: { dispatchId: string; attributes?: Record<string, string> }): Promise<void>;
  /**
   * Wait for the assistant's answer to a `post`. With `resultSchema`, the
   * answer's JSON is validated into `output`; pass the same schema to `post`
   * so the message asks for it.
   */
  awaitReply(reply: PluginReply, opts?: { resultSchema?: TSchema; timeoutMs?: number }): Promise<SubmissionResult>;
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
  /**
   * Stop a child this plugin started for the same owner: its running turn
   * and its queued work. The child settles as aborted, so a pending
   * `awaitChild` returns. `stopped` is 0 when the child was idle.
   */
  stopChild(child: PluginChild): Promise<{ stopped: number }>;
}

/** The owner's memory, read-only. A plugin puts what it finds into a child's prompt. */
export interface PluginMemory {
  /** Full-text search over the owner's memory files. */
  search(query: string, opts?: { limit?: number }): Promise<{ path: string; title: string; description: string; snippet: string }[]>;
  /** One file's rendered text, or null when there is no file at `path`. */
  read(path: string): Promise<{ path: string; content: string } | null>;
}

/** What a plugin event handler receives besides the event. */
export interface PluginEventContext {
  orgId: string;
  /** The subscription owner: the workspace the handler acts for. */
  owner: Principal;
  /** The identity the handler acts as: the owner's user id, or `team:<id>` for a team. */
  actorUserId: string;
  threads: PluginThreads;
  /**
   * This line's settings for the handler, checked against the handler's
   * `configSchema` with its defaults filled in. `{}` when the handler
   * declares no schema.
   */
  config: Record<string, unknown>;
  /** This plugin's store, scoped to `owner`. Keep pointers here, not content. */
  store: ScopedPluginStore;
  /** The owner's memory, read-only (a team's shared memory, or the person's own). */
  memory: PluginMemory;
  /**
   * The org's app credential for one of this plugin's services, or null when
   * it is not connected. The service must be the plugin's own name or one it
   * declares a credential for. `owner` picks the installation for a provider
   * with one per account (GitHub: the repository owner's login).
   */
  appToken(service: string, scope?: { owner?: string }): Promise<string | null>;
  /**
   * Aborts when the run must stop: the line was turned off, a newer event
   * superseded this run, another process took the delivery, or the server
   * is shutting down. `ctx.threads` waits end with an `AbortError` then.
   */
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
  /**
   * JSON Schema (TypeBox) for the settings a line passes to this handler as
   * `target.config`, such as review instructions or excluded paths. The
   * host checks a line's settings when it is saved and again at each
   * delivery. Absent: a line with settings is refused.
   */
  configSchema?: TSchema;
  /**
   * How runs for the same subject on one line relate. "parallel" (the
   * default) runs every delivery. "supersede" runs only the newest event
   * per subject (the owning plugin's natural subject, such as one pull
   * request): a newer event skips older deliveries that have not finished,
   * aborts their runs and stops their children, and a late older delivery
   * is skipped. Only events with the same natural subject compete. Order
   * is `occurredAt`, then receive time, so read the subject's current state
   * rather than trusting the event, and put the event id in dispatch ids.
   * Events with no natural subject run in parallel.
   */
  concurrency?: "parallel" | "supersede";
  handle(event: PluginEvent, ctx: PluginEventContext): Promise<void>;
}

/** Whether `key` is one of `patterns` (exact, or `prefix.*`). */
export function pluginHandlerAccepts(handler: Pick<PluginEventHandler, "events">, key: string): boolean {
  return handler.events.some((p) => (p.endsWith(".*") ? key.startsWith(p.slice(0, -1)) : p === key));
}
