/**
 * The handler's gather and consolidate stages and their notes in the plugin
 * thread. A note is record-only: people see what each stage produced (the
 * pack's contents and drop log, then which draft findings were posted and
 * why the rest were not) without a model turn. The full pack is in the
 * reviewer child's first message, one click away.
 */
import type { PluginEventContext, PluginThreadRef } from "@valet/engine";
import { gatherContext } from "./context/gather.js";
import type { ContextPack, PackManifest } from "./context/pack.js";
import type { DroppedFile } from "./context/rank.js";
import type { RepoRunner } from "./context/repo.js";
import type { Finding } from "./types.js";

/** Approximate characters per token, to turn the token setting into a character budget. */
const CHARS_PER_TOKEN = 4;

export interface PackRequest {
  /** The reviewer child's sandbox, from `PluginChildRequest.prepare`: the scan reads its checkout. */
  runner: RepoRunner;
  owner: string;
  repo: string;
  head: string;
  title: string;
  /** A file's text at the merge base, for convention files and playbooks. */
  readTrusted: (path: string) => Promise<string | undefined>;
  /** The diff under review, before the diff budget. */
  patch: string;
  diffDropped: DroppedFile[];
  budgetTokens: number;
  thread: PluginThreadRef;
  dispatchId: string;
}

/**
 * Build the context pack from the reviewer child's checkout and team memory, and note
 * its manifest in the plugin thread. A failure is noted and logged, and the
 * review runs on the diff alone: a missing pack must not stop a review.
 */
export async function gatherForReview(ctx: PluginEventContext, req: PackRequest): Promise<ContextPack | undefined> {
  if (req.budgetTokens <= 0) return undefined;
  const started = Date.now();
  try {
    const pack = await gatherContext({
      runner: req.runner,
      readTrusted: req.readTrusted,
      patch: req.patch,
      diffDropped: req.diffDropped,
      title: req.title,
      repo: `${req.owner}/${req.repo}`,
      memory: ctx.memory,
      budgetChars: req.budgetTokens * CHARS_PER_TOKEN,
    });
    await ctx.threads.record(req.thread, renderManifest(pack.manifest, req.head, Date.now() - started), { dispatchId: req.dispatchId });
    return pack;
  } catch (err) {
    if (ctx.signal.aborted) throw err;
    const message = err instanceof Error ? err.message : String(err);
    console.warn(`pr-review ${req.owner}/${req.repo}@${req.head.slice(0, 7)}: the context pack failed; the review runs on the diff alone`, message);
    await ctx.threads.record(req.thread, `**Context pack for \`${req.head.slice(0, 7)}\`: not built.** ${message}\n\nThe review runs on the diff alone.`, { dispatchId: req.dispatchId });
    return undefined;
  }
}

/** The pack's manifest as a short note: what went in, by section, and what was left out, with the reason. */
export function renderManifest(m: PackManifest, head: string, ms: number): string {
  const bySection = new Map<string, string[]>();
  for (const item of m.items) bySection.set(item.section, [...(bySection.get(item.section) ?? []), item.ref]);
  const lines = [
    `**Context pack for \`${head.slice(0, 7)}\`**: ${m.usedChars.toLocaleString("en-US")} of ${m.budgetChars.toLocaleString("en-US")} chars, ${m.items.length} item(s), ${m.dropped.length} left out. Built in ${(ms / 1000).toFixed(1)} s from ${m.scan.files.toLocaleString("en-US")} files.`,
    "",
    `Changed symbols: ${m.changedSymbols.slice(0, 12).join(", ") || "none found"}`,
    ...[...bySection.entries()].map(([section, refs]) => `- **${section}** (${refs.length}): ${refs.slice(0, 10).map((r) => `\`${r}\``).join(", ")}${refs.length > 10 ? `, and ${refs.length - 10} more` : ""}`),
  ];
  if (m.dropped.length > 0) {
    lines.push("", "Left out:", ...m.dropped.slice(0, 25).map((d) => `- ${d.section}: \`${d.ref}\` (${d.reason})`));
    if (m.dropped.length > 25) lines.push(`- and ${m.dropped.length - 25} more (the full list ends the pack in the reviewer's first message)`);
  }
  return lines.join("\n");
}

export interface StageOutcome {
  finding: Finding;
  /** `posted` with the id, or the reason the finding was not posted. */
  result: string;
}

/** The consolidate note: each draft finding and what happened to it. */
export function renderConsolidation(head: string, outcomes: StageOutcome[]): string {
  const posted = outcomes.filter((o) => o.result.startsWith("posted")).length;
  return [
    `**Findings for \`${head.slice(0, 7)}\`**: the reviewer drafted ${outcomes.length}; ${posted} posted.`,
    "",
    ...outcomes.map((o) => `- \`${o.finding.path}:${o.finding.line}\` ${o.finding.severity}: ${o.finding.title} → ${o.result}`),
  ].join("\n");
}
