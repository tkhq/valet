import { NotebookPen } from "lucide-react";
import { formatDiffStats } from "./diff-view";
import { MarkdownDiffBody } from "./markdown-view";
import { useMemoryViewer } from "./memory-viewer";
import { PathLabel, ToolBody } from "./tool-shell";
import { resultText, type ToolRenderer } from "./types";

/**
 * Renderer for the orchestrator's `mem_patch` tool. The args are an
 * exact-string replace (`path`, `oldString`, `newString`) — the same shape
 * as the engine's `edit` tool — so the body shows a computed unified diff
 * instead of dumping the raw strings. `oldString: ""` means "create the
 * file", which renders naturally as an all-additions diff.
 */

interface MemPatchArgs {
  path?: unknown;
  oldString?: unknown;
  newString?: unknown;
}

function getStr(args: unknown, key: keyof MemPatchArgs): string {
  if (!args || typeof args !== "object") return "";
  const v = (args as MemPatchArgs)[key];
  return typeof v === "string" ? v : "";
}

export const memPatchRenderer: ToolRenderer = {
  matches: "mem_patch",
  category: "edit",
  Icon: NotebookPen,
  formatTarget: (args) => getStr(args, "path") || undefined,
  formatSummary: (args, _result, status) => {
    if (status === "running") return undefined;
    return formatDiffStats(getStr(args, "oldString"), getStr(args, "newString"));
  },
  Body: ({ args, status, result, error }) => {
    const path = getStr(args, "path");
    const before = getStr(args, "oldString");
    const after = getStr(args, "newString");
    const failed = status === "error";
    const viewer = useMemoryViewer(path);

    const header = (
      <span className="flex items-center gap-2 min-w-0">
        {path && <PathLabel path={path} />}
        {failed && (
          <span className="text-danger-600 dark:text-danger-500 text-[10px] uppercase tracking-wider">
            failed
          </span>
        )}
      </span>
    );

    return (
      <ToolBody className="px-0 py-0">
        {status === "running" ? (
          <>
            {path && (
              <div className="px-3 py-1.5 border-b border-[--border]/60 bg-neutral-50 dark:bg-neutral-900/60 text-[11px]">
                {header}
              </div>
            )}
            <div className="px-3 py-2 text-[11px] text-muted italic font-mono">patching…</div>
          </>
        ) : (
          // Memory files are markdown, so the preview toggle is always on.
          <MarkdownDiffBody
            before={before}
            after={after}
            left={header}
            actions={viewer.expandButton}
            memoryLinks={viewer.memoryLinks}
          />
        )}
        {failed && (error || resultText(result)) && (
          <div className="px-3 py-2 border-t border-danger-500/30 bg-danger-500/5 text-[11px] text-danger-700 dark:text-danger-400 font-mono whitespace-pre-wrap">
            {error || resultText(result)}
          </div>
        )}
        {viewer.dialog}
      </ToolBody>
    );
  },
};
