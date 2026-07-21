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
import { emitNdjson, parseGlobalFlags, printErr, printLine, type ParsedFlags } from "../output.js";
import { resolveInstance } from "../resolve.js";
import { streamSession, type StreamSessionOpts } from "../stream.js";
import type { CliContext } from "../types.js";
import type {
  DecisionGate,
  EnsureOrchestratorResponse,
  SendPromptRequest,
  SendPromptResponse,
  WireEvent,
} from "../../wire/types.js";

/** The subset of `InstanceClient` the `send` command needs. */
export interface SendClient {
  ensureOrchestrator(): Promise<EnsureOrchestratorResponse>;
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
  lines.push(`resolve with: valet gates resolve ${gate.id} <actionId>`);
  return lines.join("\n");
}

/** Resolve the prompt text: joined positionals win, else `--text`. */
export function resolvePromptText(flags: ParsedFlags): string | undefined {
  const joined = flags.rest.join(" ").trim();
  if (joined !== "") return joined;
  if (typeof flags.flags.text === "string" && flags.flags.text.trim() !== "") return flags.flags.text;
  return undefined;
}

interface ConsumeCtx {
  sessionId: string;
  /** The user-message id; correlates with `submission.settled.queueItemId`. */
  messageId: string;
  /** The turn's thread; filters deltas/gates to our turn. */
  threadId: string;
  json: boolean;
}

/**
 * Consume the WS stream, rendering the turn, until our submission settles or a
 * decision gate blocks it. Pure over `(deps.stream, ctx)` — exported for tests.
 *
 * Ordering note: we `sendPrompt` first and connect the stream after. A fresh
 * connect (no `fromOffset`) begins at the live edge, so a turn that settles in
 * the sub-millisecond window before the socket attaches could be missed — the
 * loop would then end when the stream closes and we return `TurnError`. Durable
 * frames only replay on RECONNECT (`?fromOffset=`), and `streamSession` exposes
 * no "connected" signal to send-after, so this stays simple; the real
 * round-trip is validated by the T9 integration suite. In practice a real LLM
 * turn takes far longer than the connect window, so the race is theoretical.
 */
export async function consumeSend(deps: SendDeps, ctx: ConsumeCtx): Promise<number> {
  const stream = deps.stream({ url: deps.url, apiKey: deps.apiKey, sessionId: ctx.sessionId });

  for await (const ev of stream) {
    if (ctx.json) emitNdjson(ev);

    if (!ctx.json) {
      switch (ev.type) {
        case "text_delta":
          if (ev.threadId === ctx.threadId) process.stdout.write(ev.delta);
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

    // Terminal: our submission settled → map outcome to an exit code.
    if (ev.type === "submission.settled" && ev.queueItemId === ctx.messageId) {
      if (!ctx.json) printLine("");
      return outcomeToExit(ev.outcome);
    }

    // Terminal: a gate on our thread blocks the turn (no settle yet).
    if (ev.type === "decision_gate" && ev.threadId === ctx.threadId) {
      if (!ctx.json) printLine(`\n${renderGate(ev.gate)}`);
      return ExitCode.GatePending;
    }

    // Fallback terminal (mirrors chatTurn): turns are sequential per thread,
    // so a turn_end on our thread ends our turn even if the settle frame is
    // missed — without this a dropped settle leaves the command hanging.
    if (ev.type === "turn_end" && ev.threadId === ctx.threadId) {
      if (!ctx.json) printLine("");
      return ExitCode.OK;
    }
  }

  // Stream ended without a matching settle (unexpected close after retries, or
  // a missed instant-settle per the ordering note above).
  printErr("valet send: stream ended before the turn settled");
  return ExitCode.TurnError;
}

/** Pure entry: resolve target + prompt, send, then follow the turn. */
export async function runSend(deps: SendDeps, flags: ParsedFlags): Promise<number> {
  const text = resolvePromptText(flags);
  if (text === undefined) {
    printErr("valet send: a prompt is required (positional text or --text <t>)");
    return ExitCode.Usage;
  }

  const sessionOverride = flags.flags.session;
  const sessionId =
    typeof sessionOverride === "string" ? sessionOverride : (await deps.client.ensureOrchestrator()).sessionId;
  const threadOverride = typeof flags.flags.thread === "string" ? flags.flags.thread : undefined;

  const sent = await deps.client.sendPrompt(sessionId, { text, threadId: threadOverride });
  return consumeSend(deps, {
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
