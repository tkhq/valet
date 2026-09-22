import type { Session } from "../session.js";
import type { Thread } from "../thread.js";
import type { CommandContext } from "./types.js";

/**
 * Result of a built-in command run. `ok` drives the `CommandResultEntry.ok`
 * flag; `output` is rendered markdown surfaced in the transcript.
 */
export interface BuiltinResult {
  ok: boolean;
  output: string;
}

const NO_CONTEXT =
  "This deployment does not expose model or session listings.";

/**
 * Levenshtein distance for the `/model` near-miss list. Duplicated from the
 * registry's private copy on purpose: the two callers want different
 * thresholds and the function is a few lines.
 */
function levenshtein(a: string, b: string): number {
  const m = a.length;
  const n = b.length;
  const prev: number[] = Array.from({ length: n + 1 }, (_, i) => i);
  const curr: number[] = new Array<number>(n + 1);
  for (let i = 1; i <= m; i++) {
    curr[0] = i;
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      curr[j] = Math.min(
        (curr[j - 1] ?? n) + 1,
        (prev[j] ?? m) + 1,
        (prev[j - 1] ?? m + n) + cost,
      );
    }
    for (let j = 0; j <= n; j++) prev[j] = curr[j] ?? 0;
  }
  return prev[n] ?? Math.max(m, n);
}

/** Escape a table cell so a pipe in the value never breaks the markdown row. */
function cell(value: string): string {
  return value.replace(/\|/g, "\\|");
}

/**
 * Dispatch a built-in command by name. Unknown names throw — the registry only
 * resolves the eight `BUILTIN_COMMAND_NAMES`, so a name that reaches here is a
 * caller bug, not user input.
 */
export async function executeBuiltin(
  name: string,
  args: string[],
  session: Session,
  ctx: CommandContext | undefined,
  thread: Thread,
): Promise<BuiltinResult> {
  switch (name) {
    case "help":
      return helpCommand(session);
    case "status":
      return await statusCommand(session, thread);
    case "stop":
      return stopCommand(thread);
    case "clear":
      return clearCommand(session, thread);
    case "model":
      return modelCommand(args, session, ctx, thread);
    case "compact":
      return compactCommand(args, thread);
    case "new-thread":
      return newThreadCommand(session);
    case "sessions":
      return sessionsCommand(ctx);
    default:
      throw new Error(`unknown built-in command: ${name}`);
  }
}

function helpCommand(session: Session): BuiltinResult {
  const infos = session.commandRegistry().list();
  const order = { builtin: 0, plugin: 1, skill: 2 } as const;
  const grouped = [...infos].sort((a, b) => {
    const d = order[a.source] - order[b.source];
    return d !== 0 ? d : a.name.localeCompare(b.name);
  });
  const rows = grouped.map((i) => {
    const cmd = `/${i.name}${i.argHint ? ` ${i.argHint}` : ""}`;
    return `| ${cell(cmd)} | ${cell(i.source)} | ${cell(i.description)} |`;
  });
  const output = [
    "| Command | Source | Description |",
    "| --- | --- | --- |",
    ...rows,
  ].join("\n");
  return { ok: true, output };
}

async function statusCommand(session: Session, thread: Thread): Promise<BuiltinResult> {
  const state = await thread.currentQueueState();
  const context = await thread.currentContextState();
  const format = (value: number) => value.toLocaleString("en-US");
  const lines = [
    `**Session** \`${session.id}\``,
    `**Thread** \`${thread.id}\``,
    `**Active model** \`${context.model}\``,
    `**Queue** ${state.status} (${state.pending.length} pending)`,
    "**Live context (estimated)**",
  ];
  if (context.contextWindow === null) {
    lines.push(
      `- Tokens in use: ~${format(context.estimatedTokens)}`,
      "- Context-window limit: unknown",
      "- Used and remaining percentages: unavailable because the model limit is unknown",
    );
  } else {
    const usedPercent = Math.round((context.estimatedTokens / context.contextWindow) * 100);
    const remainingTokens = Math.max(0, context.contextWindow - context.estimatedTokens);
    const remainingPercent = Math.max(0, 100 - usedPercent);
    lines.push(
      `- Tokens in use: ~${format(context.estimatedTokens)} of ${format(context.contextWindow)} (${usedPercent}% used)`,
      `- Remaining: ~${format(remainingTokens)} tokens (${remainingPercent}%)`,
    );
  }
  lines.push(
    context.compactionOccurred
      ? "**Compaction** occurred in this thread."
      : "**Compaction** has not occurred in this thread.",
  );
  if (context.latestCompaction) {
    lines.push(
      `- Latest compaction: ~${format(context.latestCompaction.tokensBefore)} → ~${format(context.latestCompaction.tokensAfter)} tokens`,
    );
  }
  lines.push("Live context occupancy is separate from cumulative token usage and billed cost.");
  return { ok: true, output: lines.join("\n") };
}

async function stopCommand(thread: Thread): Promise<BuiltinResult> {
  if (!thread.hasActiveRun) {
    return { ok: false, output: "No agent turn is running." };
  }
  await thread.abort();
  return { ok: true, output: "Stopped the current agent turn." };
}

async function clearCommand(session: Session, thread: Thread): Promise<BuiltinResult> {
  const removed = await session.clearQueue(thread.id);
  return {
    ok: true,
    output:
      removed === 0
        ? "The prompt queue was already empty."
        : `Cleared ${removed} queued prompt${removed === 1 ? "" : "s"}.`,
  };
}

async function modelCommand(
  args: string[],
  session: Session,
  ctx: CommandContext | undefined,
  thread: Thread,
): Promise<BuiltinResult> {
  const target = args[0];
  if (!target) {
    // Only the listing needs host capabilities; a switch works without them.
    if (!ctx) return { ok: false, output: NO_CONTEXT };
    const models = await ctx.listModels();
    const rows = models.map((m) => `| ${cell(m.id)} | ${cell(m.name)} |`);
    const output = ["| Model id | Name |", "| --- | --- |", ...rows].join("\n");
    return { ok: true, output };
  }
  try {
    // Switch the target thread's model, not the session default — the user
    // typed the command while standing in this thread.
    const { fromModel, toModel } = await thread.setModel(target, "slash_command");
    return { ok: true, output: `Model switched from \`${fromModel}\` to \`${toModel}\`.` };
  } catch (err) {
    const models = ctx ? await ctx.listModels() : [];
    // Compare the typed id against each candidate AND against its
    // target-length prefix, so a typo in a namespaced id ("claude-oups")
    // still matches a longer canonical id ("claude-opus-4-8") whose suffix
    // the user did not type.
    const near = models
      .map((m) => m.id)
      .filter((id) => {
        const full = levenshtein(target, id);
        const prefix = levenshtein(target, id.slice(0, target.length));
        return Math.min(full, prefix) <= 3;
      });
    const suffix =
      near.length > 0 ? ` Pick one of: ${near.join(", ")}.` : "";
    const reason = err instanceof Error ? err.message : String(err);
    return { ok: false, output: `Cannot switch to \`${target}\`: ${reason}.${suffix}` };
  }
}

async function compactCommand(args: string[], thread: Thread): Promise<BuiltinResult> {
  const instructions = args.join(" ").trim();
  const outcome = await thread.compactThread({
    mode: "manual",
    ...(instructions ? { instructions } : {}),
  });
  // Report what actually happened. "Compacted." on a pass that summarized
  // nothing misleads a user the circuit breaker told to retry manually.
  if (outcome === "noop") {
    return {
      ok: true,
      output:
        "Nothing to compact: the recent turns already fit the tail budget. If the context still feels full, reduce enabled tools or start a new thread.",
    };
  }
  if (outcome === "pruned") {
    return {
      ok: true,
      output: "Pruned old tool outputs; the transcript was small enough that no summary was needed.",
    };
  }
  if (outcome === "insufficient") {
    return {
      ok: true,
      output:
        "Could not compact: the newest turn alone is larger than the model's usable context, and compaction keeps the newest turn verbatim. Shorten the last message, split it across turns, or attach it as a file.",
    };
  }
  // A separate cause needs a separate action. The message above blames the
  // newest turn, and shortening it cannot help a head that holds no text the
  // summarizer can read.
  if (outcome === "coverage_gap") {
    return {
      ok: true,
      output:
        "Could not compact: the older turns hold no text the summarizer can read, so a summary would replace them with nothing. They stay in context. Run /new-thread to continue with a fresh context.",
    };
  }
  return {
    ok: true,
    output: instructions
      ? `Compacted the thread context with instructions: ${instructions}`
      : "Compacted the thread context.",
  };
}

async function newThreadCommand(session: Session): Promise<BuiltinResult> {
  const thread = await session.newThread();
  return { ok: true, output: `Started a fresh thread \`${thread.id}\`.` };
}

async function sessionsCommand(ctx: CommandContext | undefined): Promise<BuiltinResult> {
  if (!ctx) return { ok: false, output: NO_CONTEXT };
  const sessions = await ctx.listChildSessions();
  if (sessions.length === 0) {
    return { ok: true, output: "No child sessions." };
  }
  const rows = sessions.map(
    (s) => `| ${cell(s.id)} | ${cell(s.title ?? "")} | ${cell(s.status)} |`,
  );
  const output = ["| Session | Title | Status |", "| --- | --- | --- |", ...rows].join("\n");
  return { ok: true, output };
}
