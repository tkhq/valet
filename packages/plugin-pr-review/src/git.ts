import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { rankPatch, type DroppedFile } from "./context/rank.js";

const run = promisify(execFile);

export async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await run("git", args, { cwd, maxBuffer: 256 * 1024 * 1024 });
  return stdout;
}

export interface PullRequestDiff {
  stat: string;
  /** Unified diff, possibly cut to the budget. */
  patch: string;
  truncated: boolean;
  files: string[];
  /** Files the budget left out, and why. */
  dropped?: DroppedFile[];
}

/** Diff BASE..HEAD, keeping whole files until the character budget runs out. */
export async function diffPullRequest(
  cwd: string,
  base: string,
  head: string,
  budgetChars: number,
  /** Limit the diff to these paths. */
  paths?: string[],
): Promise<PullRequestDiff> {
  const only = paths !== undefined ? ["--", ...paths] : [];
  const stat = await git(cwd, ["diff", "--stat=200", base, head, ...only]);
  const names = (await git(cwd, ["diff", "--name-only", base, head, ...only])).split("\n").filter(Boolean);
  const full = await git(cwd, ["diff", "--unified=5", base, head, ...only]);
  return { stat, files: names, ...cutPatch(full, budgetChars) };
}

/**
 * Fit a unified diff to the character budget: noise files go first, then
 * whole files are kept risky paths first and by size of change. See
 * `rankPatch`. `dropped` names each file left out and why.
 */
export function cutPatch(full: string, budgetChars: number, riskPaths: readonly string[] = []): { patch: string; truncated: boolean; dropped: DroppedFile[] } {
  return rankPatch(full, budgetChars, riskPaths);
}
