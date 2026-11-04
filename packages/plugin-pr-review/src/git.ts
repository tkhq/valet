import { execFile } from "node:child_process";
import { promisify } from "node:util";

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
  if (full.length <= budgetChars) return { stat, patch: full, truncated: false, files: names };

  const chunks = full.split(/^(?=diff --git )/m);
  const kept: string[] = [];
  let used = 0;
  const skipped: string[] = [];
  for (const chunk of chunks) {
    if (used + chunk.length <= budgetChars) {
      kept.push(chunk);
      used += chunk.length;
    } else {
      skipped.push(chunk.split("\n", 1)[0]);
    }
  }
  const note = `\n# Diff budget reached. Not shown (run git diff yourself):\n${skipped.map((s) => `#   ${s}`).join("\n")}\n`;
  return { stat, patch: kept.join("") + note, truncated: true, files: names };
}
