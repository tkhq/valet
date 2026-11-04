import { git } from "./git.js";

export type LineFate =
  /** The line is unchanged; `line` is its number at the new commit. */
  | { kind: "moved"; line: number }
  /** The new commit changed or deleted the line, or the file is gone. */
  | { kind: "touched" };

interface Hunk {
  oldStart: number;
  oldCount: number;
  newStart: number;
  newCount: number;
}

const HUNK_RE = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

export function parseHunks(diff: string): Hunk[] {
  const hunks: Hunk[] = [];
  for (const line of diff.split("\n")) {
    const m = HUNK_RE.exec(line);
    if (!m) continue;
    hunks.push({
      oldStart: Number(m[1]),
      oldCount: m[2] === undefined ? 1 : Number(m[2]),
      newStart: Number(m[3]),
      newCount: m[4] === undefined ? 1 : Number(m[4]),
    });
  }
  return hunks;
}

/**
 * Where line `line` of the old version ends up, given zero-context hunks.
 * A line inside a hunk's old range was changed; any other line shifts by the
 * net size of the hunks before it.
 */
export function mapLineThroughHunks(hunks: Hunk[], line: number): LineFate {
  let shift = 0;
  for (const h of hunks) {
    // With -U0 a pure insertion has oldCount 0 and sits after line oldStart.
    const oldEnd = h.oldStart + h.oldCount - 1;
    if (h.oldCount > 0 && line >= h.oldStart && line <= oldEnd) return { kind: "touched" };
    const before = h.oldCount === 0 ? line <= h.oldStart : line < h.oldStart;
    if (before) break;
    shift += h.newCount - h.oldCount;
  }
  return { kind: "moved", line: line + shift };
}

/** Follow one line of `path` from commit `from` to commit `to`. */
export async function mapLine(cwd: string, from: string, to: string, path: string, line: number): Promise<LineFate> {
  const names = await git(cwd, ["diff", "--name-status", "-M", from, to, "--", path]).catch(() => "");
  if (/^D\t/m.test(names)) return { kind: "touched" };
  const diff = await git(cwd, ["diff", "--unified=0", from, to, "--", path]);
  return mapLineThroughHunks(parseHunks(diff), line);
}

/**
 * The lines of the new file that a GitHub review comment can anchor to:
 * every added or context line inside the patch's hunks (the RIGHT side).
 */
export function commentableLines(patch: string): Set<number> {
  const lines = new Set<number>();
  let right = 0;
  let inHunk = false;
  for (const line of patch.split("\n")) {
    const m = HUNK_RE.exec(line);
    if (m) {
      right = Number(m[3]);
      inHunk = true;
      continue;
    }
    if (!inHunk) continue;
    if (line.startsWith("+") || line.startsWith(" ")) lines.add(right++);
    else if (line.startsWith("diff --git ")) inHunk = false;
  }
  return lines;
}
