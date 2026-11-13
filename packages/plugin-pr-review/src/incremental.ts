import { git } from "./git.js";
import { mapLine } from "./linemap.js";
import { runReviewPipeline, type AgentRunner, type PipelineOptions, type PipelineResult } from "./pipeline.js";
import { openFindings, type PullRequestReviewState, type ReviewStateStore, type TrackedFinding } from "./state.js";
import type { Finding } from "./types.js";
import { createVerifierSpec } from "./verify.js";

export interface IncrementalReviewOptions extends Omit<PipelineOptions, "incrementFrom" | "knownFindings"> {
  /** Stable PR identity, e.g. `tkhq/valet#1120`. */
  key: string;
  store: ReviewStateStore;
  /** Rechecks of earlier findings in flight at once. Default 4. */
  recheckConcurrency?: number;
}

export interface IncrementalReviewResult {
  mode: "full" | "incremental" | "unchanged";
  /** Findings to post now: new in this round. */
  posted: TrackedFinding[];
  /** Earlier findings this round resolved (the new commits fixed them). */
  resolved: TrackedFinding[];
  /** Earlier findings still open, with their lines moved to the new head. */
  stillOpen: TrackedFinding[];
  state: PullRequestReviewState;
  pipeline?: PipelineResult;
}

/**
 * Review the PR at `head`, building on what earlier reviews of the same PR
 * found. The first review, and any review after a force-push or rebase, is
 * full. A later push gets a review of only the new commits, and the earlier
 * findings are carried forward: a finding in a file the new commits changed
 * is rechecked and resolved if it is fixed; the rest keep their place.
 */
export async function reviewPullRequestIncrement(
  opts: IncrementalReviewOptions,
  run: AgentRunner,
): Promise<IncrementalReviewResult> {
  const loaded = await opts.store.get(opts.key);
  const prior = loaded?.state;
  const head = (await git(opts.workspace, ["rev-parse", opts.head])).trim();
  const mergeBase = (await git(opts.workspace, ["merge-base", opts.base, head])).trim();

  if (prior && prior.lastReviewedHead === head) {
    return { mode: "unchanged", posted: [], resolved: [], stillOpen: openFindings(prior), state: prior };
  }

  const incremental = prior !== undefined && (await isAncestor(opts.workspace, prior.lastReviewedHead, head));
  const from = prior?.lastReviewedHead;

  // 1. Carry earlier open findings to the new head. A finding in a file the
  // new commits changed is rechecked, since a fix can land a few lines away
  // from the anchored line. Findings in untouched files only move.
  const stillOpen: TrackedFinding[] = [];
  const resolved: TrackedFinding[] = [];
  const toRecheck: TrackedFinding[] = [];
  const fromKnown = from !== undefined && (await commitExists(opts.workspace, from));
  const changed = fromKnown
    ? new Set((await git(opts.workspace, ["diff", "--name-only", from, head])).split("\n").filter(Boolean))
    : undefined;
  for (const f of openFindings(prior)) {
    if (changed === undefined || changed.has(f.path) || from === undefined) {
      toRecheck.push(f);
      continue;
    }
    const fate = await mapLine(opts.workspace, from, head, f.path, f.line);
    if (fate.kind === "moved") stillOpen.push({ ...f, line: fate.line, lastSeen: head });
    else toRecheck.push(f);
  }
  await forEachLimit(toRecheck, opts.recheckConcurrency ?? 4, async (f, i) => {
    const spec = await createVerifierSpec({
      workspace: opts.workspace,
      base: mergeBase,
      head,
      title: opts.title,
      body: opts.body,
      finding: f,
      label: `recheck:${i}`,
      ...(from !== undefined ? { recheckFrom: from } : {}),
    });
    await run(spec);
    const v = spec.verdict();
    // Only a refutation closes a finding; an unclear recheck keeps it open.
    if (v?.verdict === "refuted") {
      resolved.push({ ...f, status: "resolved", lastSeen: head, resolution: v.counter_evidence || v.refutation_reason || "fixed" });
    } else {
      stillOpen.push({ ...f, line: v?.current_line ?? f.line, lastSeen: head });
    }
  });

  // 2. Review the new commits (or the whole PR), told what is already open.
  const pipeline = await runReviewPipeline(
    {
      ...opts,
      head,
      ...(incremental && from !== undefined ? { incrementFrom: from } : {}),
      knownFindings: stillOpen.map((f) => ({ path: f.path, line: f.line, title: f.title })),
    },
    run,
  );

  // 3. New findings: drop near-duplicates of open ones, then assign ids.
  let nextId = prior?.nextId ?? 1;
  const posted: TrackedFinding[] = [];
  for (const f of pipeline.review?.findings ?? []) {
    if ([...stillOpen, ...posted].some((o) => sameIssue(o, f))) continue;
    posted.push({ ...f, id: `f${nextId++}`, status: "open", firstSeen: head, lastSeen: head });
  }

  const byId = new Map<string, TrackedFinding>();
  for (const f of prior?.findings ?? []) byId.set(f.id, f);
  for (const f of [...stillOpen, ...resolved, ...posted]) byId.set(f.id, f);
  const state: PullRequestReviewState = {
    version: 1,
    key: opts.key,
    mergeBase,
    lastReviewedHead: head,
    findings: [...byId.values()],
    rounds: [
      ...(prior?.rounds ?? []),
      {
        head,
        mode: incremental ? "incremental" : "full",
        at: new Date().toISOString(),
        newFindings: posted.map((f) => f.id),
        resolved: resolved.map((f) => f.id),
      },
    ],
    nextId,
  };
  // A failed review must not advance the state, or its commits would never be reviewed.
  if (pipeline.outcome === "completed") await opts.store.put(state, loaded?.revision);

  return { mode: incremental ? "incremental" : "full", posted, resolved, stillOpen, state, pipeline };
}

/**
 * Same issue: same file, anchored within 3 lines, and titles that share at
 * least 40% of their words.
 */
export function sameIssue(a: Pick<Finding, "path" | "line" | "title">, b: Pick<Finding, "path" | "line" | "title">): boolean {
  if (a.path !== b.path || Math.abs(a.line - b.line) > 3) return false;
  const words = (s: string): Set<string> => new Set(s.toLowerCase().match(/[a-z0-9_]{3,}/g) ?? []);
  const wa = words(a.title);
  const wb = words(b.title);
  const shared = [...wa].filter((w) => wb.has(w)).length;
  const union = new Set([...wa, ...wb]).size;
  return union > 0 && shared / union >= 0.4;
}

async function isAncestor(cwd: string, ancestor: string, head: string): Promise<boolean> {
  return git(cwd, ["merge-base", "--is-ancestor", ancestor, head]).then(
    () => true,
    () => false,
  );
}

async function commitExists(cwd: string, sha: string): Promise<boolean> {
  return git(cwd, ["cat-file", "-e", `${sha}^{commit}`]).then(
    () => true,
    () => false,
  );
}

async function forEachLimit<T>(items: T[], limit: number, fn: (item: T, index: number) => Promise<void>): Promise<void> {
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(Math.max(1, limit), items.length) }, async () => {
      while (next < items.length) {
        const i = next++;
        await fn(items[i], i);
      }
    }),
  );
}
