import { Link } from "@tanstack/react-router";
import type { SecurityDiffWire } from "@valet/api/wire";
import { cn } from "~/lib/cn";

/**
 * Re-scan / iterate: the diff summary banner (valet-security design §Re-scan /
 * iterate). Reads "Re-scan of the prior review — N new, N recurring, N fixed"
 * with a link back to the parent session.
 *
 * `fixedCount` is null while the scan runs (a scan that has not finished has
 * not looked everywhere yet), so the banner says the fixed count arrives once
 * it finishes. `terminal` mirrors the engagement's terminal status — the same
 * gate the server uses to fill `fixedCount`.
 *
 * The scope line has three cases: an empty diff (a base commit, but no changed
 * files — carried findings re-checked, no new ones), a scoped diff (N changed
 * files since the parent SHA), and a full re-scan (no diff captured).
 */
export function RescanDiffBanner({
  diff,
  terminal,
  baseRef,
  changedPaths,
  className,
}: {
  diff: SecurityDiffWire;
  /** True once the engagement is completed/failed — `fixedCount` is a number. */
  terminal: boolean;
  /** Diff-scoped re-scan: the prior review's SHA the sweeps diffed against.
   * Null on a full-scan fallback. */
  baseRef?: string | null;
  /** Diff-scoped re-scan: the changed file paths the sweeps scoped to. Null on
   * a full-scan fallback. */
  changedPaths?: string[] | null;
  className?: string;
}) {
  const parts = [`${diff.newCount} new`, `${diff.recurringCount} recurring`];
  if (terminal && diff.fixedCount !== null) {
    parts.push(`${diff.fixedCount} fixed`);
  }
  // Diff-scope line (re-scan / iterate). Three cases:
  //  1. Empty diff: the re-scan captured a base commit but nothing changed.
  //     Say so plainly — the carried findings were re-checked, no new ones.
  //  2. Scoped: N changed files since the parent's SHA.
  //  3. Full re-scan: no diff was captured (prior commit unavailable).
  const scoped = baseRef != null && changedPaths != null;
  const emptyDiff = scoped && changedPaths.length === 0;
  const carried = diff.recurringCount + (terminal && diff.fixedCount !== null ? diff.fixedCount : 0);
  const scopeText = emptyDiff
    ? `No changes since the last review — carried ${carried} finding${carried === 1 ? "" : "s"}, re-checked, ${diff.newCount} new.`
    : scoped
      ? `Scoped to ${changedPaths.length} changed file${changedPaths.length === 1 ? "" : "s"} since ${baseRef.slice(0, 12)}`
      : "Full re-scan (prior commit unavailable)";
  return (
    <div
      className={cn(
        "rounded border border-line bg-moss-wash px-3 py-2 text-xs text-ink",
        className,
      )}
      aria-label="Re-scan diff"
    >
      <span className="font-medium">Re-scan of </span>
      {diff.parentSessionId ? (
        <Link
          to="/sessions/$sessionId"
          params={{ sessionId: diff.parentSessionId }}
          className="text-accent-600 dark:text-accent-100 hover:underline"
        >
          the prior review
        </Link>
      ) : (
        <span className="text-muted">the prior review</span>
      )}
      <span> — {parts.join(", ")}</span>
      {(!terminal || diff.fixedCount === null) && (
        <span className="text-muted"> (fixed count after it finishes)</span>
      )}
      {diff.carriedRefutedCount > 0 && (
        <span className="text-muted">
          {" · "}
          {diff.carriedRefutedCount} dismissal{diff.carriedRefutedCount === 1 ? "" : "s"} carried
        </span>
      )}
      <div className="mt-1 text-muted">{scopeText}</div>
    </div>
  );
}
