import type { ListWorkflowRunsResponse } from "@valet/api/wire";

/**
 * How many runs to show for a run list: the page's length, with a `+` when
 * `nextCursor` says older runs exist. Every caller uses this — a bare
 * `runs.length` reads as the total and under-reports a workflow with more
 * runs than one page holds.
 */
export function runCountLabel(page: ListWorkflowRunsResponse | undefined): string | undefined {
  if (!page) return undefined;
  return `${page.runs.length}${page.nextCursor ? "+" : ""}`;
}
