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
  SendPromptRequest,
  SendPromptResponse,
  WireEvent,
} from "../../wire/types.js";

/** The subset of `InstanceClient` the `send` command needs. */
export interface SendClient {
  getThread(id: string): Promise<{ sessionId: string }>;
  ensureOrchestrator(): Promise<EnsureWorkspaceRuntimeResponse>;
  sendPrompt(id: string, body: SendPromptRequest): Promise<SendPromptResponse>;
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

interface ConsumeCtx {
  sessionId: string;
  /** The user-message id; correlates with `submission.settled.queueItemId`. */
  messageId: string;
  /** The turn's thread; filters deltas/gates to our turn. */
  threadId: string;
  json: boolean;
  /** How long to keep consuming after `turn_end` for the trailing settle
   * frame before falling back to OK. Tests inject a small value. */
  settleGraceMs?: number;
}

/**
 * Consume the WS stream, rendering the turn, until our submission settles or a
 * decision gate blocks it. Pure over `(deps.stream, ctx)` — exported for tests.
 *
 * Ordering note: the engine emits `submission.settled` AFTER `turn_end` —
 * settlement is post-turn bookkeeping (reserve → repair → finalize, several
 * store round-trips), so on the wire the settle frame always trails the
 * turn_end frame by a few milliseconds. `turn_end` therefore must NOT be
 * treated as terminal: we keep consuming for a short grace window so the
 * settle's real outcome (completed vs failed/aborted) decides the exit code.
 * The OK fallback only fires when the settle frame never arrives (stream
 * close or grace expiry).
 *
 * The prompt is sent with `inject`, so on a busy thread it either waits
 * behind the running turn or joins it. A turn_end counts only while the
 * answering item is the thread's active item (`queue.state`, which the
 * socket seeds on connect): the turn our prompt waited behind ends first.
 * A `merged` settle means our prompt joined a running turn, so we follow
 * that turn's item (`mergedIntoItemId`) to its own settle.
 */
export async function consumeSend(deps: Omit<SendDeps, "client">, ctx: ConsumeCtx): Promise<number> {
  const stream = deps.stream({ url: deps.url, apiKey: deps.apiKey, sessionId: ctx.sessionId });
  const graceMs = ctx.settleGraceMs ?? 3_000;
  const iter = stream[Symbol.asyncIterator]();
  let turnEnded = false;
  let answering = ctx.messageId;
  let activeItemId: string | undefined;

  const endTurnOutput = (): void => {
    if (!ctx.json) printLine("");
  };

  for (;;) {
    let result: IteratorResult<WireEvent>;
    if (!turnEnded) {
      result = await iter.next();
    } else {
      // Post-turn grace: wait briefly for the trailing settle frame.
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
      if (turnEnded) return ExitCode.OK; // turn ended; settle frame dropped
      printErr("valet send: stream ended before the turn settled");
      return ExitCode.TurnError;
    }
    const ev = result.value;
    if (ctx.json) emitNdjson(ev);

    if (!ctx.json) {
      switch (ev.type) {
        case "text_delta":
          if (ev.threadId === ctx.threadId) printText(ev.delta);
          break;
        case "tool_start":
          if (ev.threadId === ctx.threadId) printLine(renderToolStart(ev.toolName));
          break;
        case "tool_end":
          if (ev.threadId === ctx.threadId) printLine(renderToolEnd(ev.toolName, ev.isError));
          break;
        case "error":
          printErr(`error: ${ev.message}`);
          break;
        default:
          break;
      }
    }

    if (ev.type === "queue.state" && ev.threadId === ctx.threadId) activeItemId = ev.state.activeItemId;

    // Our prompt joined a running turn: that turn's settle is ours now.
    if (ev.type === "submission.settled" && ev.queueItemId === answering && ev.outcome === "merged" && ev.mergedIntoItemId) {
      answering = ev.mergedIntoItemId;
      continue;
    }

    // Terminal: our submission settled → map outcome to an exit code.
    if (ev.type === "submission.settled" && ev.queueItemId === answering) {
      if (!turnEnded) endTurnOutput();
      return outcomeToExit(ev.outcome);
    }

    // Terminal: a gate on our thread blocks the turn (no settle yet).
    if (ev.type === "decision_gate" && ev.threadId === ctx.threadId) {
      if (!ctx.json) printLine(`\n${renderGate(ev.gate)}`);
      return ExitCode.GatePending;
    }

    // Our turn ended: not terminal — enter the settle grace window.
    if (ev.type === "turn_end" && ev.threadId === ctx.threadId && activeItemId === answering && !turnEnded) {
      turnEnded = true;
      endTurnOutput();
    }
  }
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
  return consumeSend({ ...deps, stream: () => events }, {
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
