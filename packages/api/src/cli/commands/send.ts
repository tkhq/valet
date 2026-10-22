/**
 * `valet send [<prompt words…>] [--text <t>] [--session <id>] [--thread <id>]`
 *
 * Sends a prompt (default target: the caller's orchestrator) and follows the
 * turn over the session WS until it settles or blocks on a decision gate.
 *
 * Structure: `run` is a thin shell (resolve instance, build the client + the
 * real `streamSession`, delegate). The turn loop, the exit-code mapping, and
 * the render helpers are pure exported functions so they're unit-testable with
 * a stub client and a scripted async-iterable of `WireEvent`s — no live WS.
 */
import { InstanceClient } from "../client.js";
import { ExitCode } from "../exit.js";
import { emitNdjson, parseGlobalFlags, printErr, printLine, printText, type ParsedFlags } from "../output.js";
import { resolveInstance } from "../resolve.js";
import { streamSession, type StreamSessionOpts } from "../stream.js";
import type { CliContext } from "../types.js";
import type {
  DecisionGate,
  EnsureWorkspaceRuntimeResponse,
  ListDecisionsResponse,
  SendPromptRequest,
  SendPromptResponse,
  WireEvent,
} from "../../wire/types.js";

/** The subset of `InstanceClient` the `send` command needs. */
export interface SendClient {
  getThread(id: string): Promise<{ sessionId: string }>;
  ensureOrchestrator(): Promise<EnsureWorkspaceRuntimeResponse>;
  sendPrompt(id: string, body: SendPromptRequest): Promise<SendPromptResponse>;
  /** Reads a gate the stream names only by id (`queue.state.blockedGateId`). */
  listThreadDecisions?(id: string): Promise<ListDecisionsResponse>;
}

/** The WS stream factory — the real `streamSession`, or a scripted stub in tests. */
export type StreamFn = (opts: StreamSessionOpts) => AsyncIterable<WireEvent>;

export interface SendDeps {
  client: SendClient;
  stream: StreamFn;
  url: string;
  apiKey?: string;
}

/** The outcome carried by a `submission.settled` frame. */
type SettledOutcome = Extract<WireEvent, { type: "submission.settled" }>["outcome"];

/**
 * Map a settled submission's outcome to a process exit code.
 *
 * - `completed` / `merged` → OK (the work ran or was folded into another turn).
 * - `failed` / `aborted` / `superseded` → TurnError (our turn did not run to a
 *   clean completion — a caller scripting this send should treat it as failure).
 */
export function outcomeToExit(outcome: SettledOutcome): ExitCode {
  switch (outcome) {
    case "completed":
    case "merged":
      return ExitCode.OK;
    case "failed":
    case "aborted":
    case "superseded":
      return ExitCode.TurnError;
  }
}

/** One-line render of a starting tool call. */
export function renderToolStart(toolName: string): string {
  return `⚙ ${toolName} · running`;
}

/** One-line render of a finished tool call (✓ ok / ✗ error). */
export function renderToolEnd(toolName: string, isError: boolean): string {
  return `${isError ? "✗" : "✓"} ${toolName}`;
}

/** Multi-line render of a blocking decision gate + its selectable actions. */
export function renderGate(gate: DecisionGate): string {
  const lines = [`decision required: ${gate.title} [${gate.type}]`];
  if (gate.body) lines.push(gate.body);
  for (const a of gate.actions) lines.push(`  - ${a.id}: ${a.label}`);
  lines.push(`resolve with: valet gates resolve ${gate.id} <actionId> --thread ${gate.threadId}`);
  return lines.join("\n");
}

/** A pending gate whose details could not be read. */
export function renderGateId(gateId: string, threadId: string): string {
  return [`decision required: ${gateId}`, `see it with: valet gates list --thread ${threadId}`].join("\n");
}

/** Resolve the prompt text: joined positionals win, else `--text`. */
export function resolvePromptText(flags: ParsedFlags): string | undefined {
  const joined = flags.rest.join(" ").trim();
  if (joined !== "") return joined;
  if (typeof flags.flags.text === "string" && flags.flags.text.trim() !== "") return flags.flags.text;
  return undefined;
}

/** How long to wait for the stream's subscription before sending anyway, for a server that never sends `sandbox.status`. */
const SUBSCRIBE_WAIT_MS = 5_000;

/**
 * Open the session stream, wait until the server has subscribed it, then run
 * `submit`. A fresh socket replays nothing, so a prompt that settles, or
 * joins the running turn, before the socket subscribes never reaches a
 * follower that connected after sending. The server sends `sandbox.status`
 * once, right after it subscribes. The frames read before it (the queue
 * snapshot) stay in `events`.
 */
export async function submitSubscribed<T>(
  stream: StreamFn,
  opts: StreamSessionOpts,
  submit: () => Promise<T>,
  waitMs = SUBSCRIBE_WAIT_MS,
): Promise<{ sent: T; events: AsyncIterable<WireEvent> }> {
  const iter = stream(opts)[Symbol.asyncIterator]();
  const early: Array<IteratorResult<WireEvent>> = [];
  let pending: Promise<IteratorResult<WireEvent>> | undefined;
  const deadline = Date.now() + waitMs;
  for (;;) {
    const next = iter.next();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const raced = await Promise.race([
      next,
      new Promise<"timeout">((resolveTimeout) => {
        timer = setTimeout(() => resolveTimeout("timeout"), Math.max(0, deadline - Date.now()));
        timer.unref();
      }),
    ]);
    clearTimeout(timer);
    if (raced === "timeout") {
      pending = next;
      break;
    }
    early.push(raced);
    if (raced.done || raced.value.type === "sandbox.status" || raced.value.type === "error") break;
  }
  let sent: T;
  try {
    sent = await submit();
  } catch (err) {
    void iter.return?.();
    throw err;
  }
  async function* events(): AsyncGenerator<WireEvent> {
    try {
      for (const r of [...early, ...(pending ? [await pending] : [])]) {
        if (r.done) return;
        yield r.value;
      }
      for (;;) {
        const r = await iter.next();
        if (r.done) return;
        yield r.value;
      }
    } finally {
      void iter.return?.();
    }
  }
  return { sent, events: { [Symbol.asyncIterator]: events } };
}

/** What a frame means for the turn that answers our prompt. */
export type TurnSignal =
  | { kind: "settled"; outcome: SettledOutcome }
  /** The answering item left the thread's active slot with no settle frame:
   * the engine settles an item before it moves the slot on, so the frame was lost. */
  | { kind: "left" }
  /** A decision gate blocks the thread, so it blocks our prompt too, whether
   * it runs or waits behind the gated turn. A socket that connects to a
   * blocked thread gets only the gate's id, in `queue.state`. */
  | { kind: "gate"; gateId: string; gate?: DecisionGate };

/**
 * Follows the turn that answers our prompt on one thread. It starts as our
 * own item and moves to the running item when ours joins that turn (a
 * `merged` settle with `mergedIntoItemId`). `queue.state`, which the socket
 * seeds on connect, says which item runs: the other items' output is not
 * our reply, and a `turn_end` (one per model round) ends nothing.
 */
export function followTurn(messageId: string | null, threadId: string): {
  /** True while the answering item runs, so the thread's output is our reply. */
  ours(): boolean;
  read(ev: WireEvent): TurnSignal | undefined;
} {
  let answering = messageId;
  let activeItemId: string | undefined;
  let wasActive = false;
  const ours = (): boolean => answering !== null && activeItemId === answering;
  return {
    ours,
    read(ev) {
      if (ev.type === "queue.state" && ev.threadId === threadId) {
        activeItemId = ev.state.activeItemId;
        const active = ours();
        const left = wasActive && !active && answering !== null && !ev.state.pendingIds.includes(answering);
        wasActive = active;
        if (left) return { kind: "left" };
        if (ev.state.status === "blocked_on_decision_gate" && ev.state.blockedGateId) {
          return { kind: "gate", gateId: ev.state.blockedGateId };
        }
        return undefined;
      }
      if (ev.type === "decision_gate" && ev.threadId === threadId) return { kind: "gate", gateId: ev.gate.id, gate: ev.gate };
      if (ev.type !== "submission.settled" || ev.queueItemId !== answering) return undefined;
      if (ev.outcome === "merged" && ev.mergedIntoItemId) {
        answering = ev.mergedIntoItemId;
        wasActive = ours();
        return undefined;
      }
      return { kind: "settled", outcome: ev.outcome };
    },
  };
}

interface ConsumeCtx {
  sessionId: string;
  /** The user-message id; correlates with `submission.settled.queueItemId`. */
  messageId: string;
  /** The turn's thread; filters deltas/gates to our turn. */
  threadId: string;
  json: boolean;
  /** How long to wait for a settle frame after the answering item left the
   * thread's active slot without one, before falling back to OK. Tests
   * inject a small value. */
  settleGraceMs?: number;
}

/**
 * Consume the WS stream, rendering the turn, until our submission settles or a
 * decision gate blocks it. Pure over `(deps.stream, ctx)` — exported for tests.
 *
 * The end of the turn is the answering item's `submission.settled`
 * (`followTurn`). Only that turn's output is rendered: a prompt sent with
 * `inject` can wait behind another turn. A gate on the thread blocks our
 * prompt, so it returns GatePending; a gate that the stream names only by id
 * is read through `readGates`.
 *
 * Fallback for a lost settle frame: when the answering item leaves the
 * thread's active slot with no settle frame, we wait a short grace window for
 * it, then return OK.
 */
export async function consumeSend(
  deps: Omit<SendDeps, "client"> & { readGates?: (threadId: string) => Promise<DecisionGate[]> },
  ctx: ConsumeCtx,
): Promise<number> {
  const stream = deps.stream({ url: deps.url, apiKey: deps.apiKey, sessionId: ctx.sessionId });
  const graceMs = ctx.settleGraceMs ?? 3_000;
  const iter = stream[Symbol.asyncIterator]();
  const turn = followTurn(ctx.messageId, ctx.threadId);
  let left = false;

  const endTurnOutput = (): void => {
    if (!ctx.json) printLine("");
  };

  for (;;) {
    let result: IteratorResult<WireEvent>;
    if (!left) {
      result = await iter.next();
    } else {
      // The item left the active slot: wait briefly for its settle frame.
      const raced = await Promise.race([
        iter.next().then((r) => ({ kind: "event" as const, r })),
        new Promise<{ kind: "timeout" }>((resolveTimeout) => {
          const t = setTimeout(() => resolveTimeout({ kind: "timeout" }), graceMs);
          t.unref();
        }),
      ]);
      if (raced.kind === "timeout") return ExitCode.OK;
      result = raced.r;
    }

    if (result.done) {
      if (left) return ExitCode.OK; // the item left the slot; settle frame dropped
      printErr("valet send: stream ended before the turn settled");
      return ExitCode.TurnError;
    }
    const ev = result.value;
    if (ctx.json) emitNdjson(ev);

    if (!ctx.json) {
      // Only the answering turn's output is our reply.
      switch (ev.type) {
        case "text_delta":
          if (ev.threadId === ctx.threadId && turn.ours()) printText(ev.delta);
          break;
        case "tool_start":
          if (ev.threadId === ctx.threadId && turn.ours()) printLine(renderToolStart(ev.toolName));
          break;
        case "tool_end":
          if (ev.threadId === ctx.threadId && turn.ours()) printLine(renderToolEnd(ev.toolName, ev.isError));
          break;
        case "error":
          printErr(`error: ${ev.message}`);
          break;
        default:
          break;
      }
    }

    const signal = turn.read(ev);
    if (signal?.kind === "settled") {
      if (!left) endTurnOutput();
      return outcomeToExit(signal.outcome);
    }
    if (signal?.kind === "left" && !left) {
      left = true;
      endTurnOutput();
    }
    if (signal?.kind === "gate") {
      if (!ctx.json) {
        const gate = signal.gate ?? (await deps.readGates?.(ctx.threadId).catch(() => undefined))?.find((g) => g.id === signal.gateId);
        printLine(`\n${gate ? renderGate(gate) : renderGateId(signal.gateId, ctx.threadId)}`);
      }
      return ExitCode.GatePending;
    }
  }
}

/** The pending gates of a thread, through a client that can read them. */
export function readGatesOf(client: { listThreadDecisions?(id: string): Promise<ListDecisionsResponse> }): (threadId: string) => Promise<DecisionGate[]> {
  return async (threadId) => (await client.listThreadDecisions?.(threadId))?.gates ?? [];
}

/** Pure entry: resolve target + prompt, send, then follow the turn. */
export async function runSend(deps: SendDeps, flags: ParsedFlags): Promise<number> {
  if (flags.flags.thread === true || flags.flags.session === true || flags.flags.thread === "" || flags.flags.session === "") {
    printErr("Provide an id after --thread or --session.");
    return ExitCode.Usage;
  }
  const text = resolvePromptText(flags);
  if (text === undefined) {
    printErr("valet send: a prompt is required (positional text or --text <t>)");
    return ExitCode.Usage;
  }

  const sessionOverride = flags.flags.session;
  const threadOverride = typeof flags.flags.thread === "string" ? flags.flags.thread : undefined;
  const resolved = threadOverride ? await deps.client.getThread(threadOverride) : undefined;
  if (resolved && typeof sessionOverride === "string" && sessionOverride !== resolved.sessionId) {
    printErr("The thread does not belong to the specified runtime. Use its runtime or omit --session.");
    return ExitCode.Usage;
  }
  const sessionId = resolved?.sessionId ?? (typeof sessionOverride === "string" ? sessionOverride : (await deps.client.ensureOrchestrator()).sessionId);

  const { sent, events } = await submitSubscribed(
    deps.stream,
    { url: deps.url, apiKey: deps.apiKey, sessionId },
    () => deps.client.sendPrompt(sessionId, { text, threadId: threadOverride, queueMode: "inject" }),
  );
  // A null messageId means the text ran as a slash command: it executed
  // immediately, took no queue item, and its result arrives as a
  // command_result entry — there is no turn to follow.
  if (sent.messageId === null) {
    if (flags.json) {
      emitNdjson({ type: "command_accepted", sessionId, threadId: sent.threadId });
    } else {
      printLine(`command executed on thread ${sent.threadId}`);
    }
    return ExitCode.OK;
  }
  return consumeSend({ ...deps, stream: () => events, readGates: readGatesOf(deps.client) }, {
    sessionId,
    messageId: sent.messageId,
    // Prefer the server-echoed thread (resolves the default thread when we
    // sent none) so delta/gate filtering targets the real turn.
    threadId: sent.threadId,
    json: flags.json,
  });
}

export async function run(args: string[], ctx: CliContext): Promise<number> {
  const flags = parseGlobalFlags(args);
  const instance = resolveInstance({
    flag: typeof flags.flags.instance === "string" ? flags.flags.instance : undefined,
    env: process.env.VALET_INSTANCE,
    config: ctx.config,
  });
  const client = new InstanceClient({ url: instance.url, apiKey: instance.apiKey });
  return runSend({ client, stream: streamSession, url: instance.url, apiKey: instance.apiKey }, flags);
}
