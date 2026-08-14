import { Replace } from "lucide-react";
import { DiffView, formatDiffStats } from "./diff-view";
import { ToolBody } from "./tool-shell";
import { parsedResultData } from "./workflow";
import type { ToolRenderer } from "./types";

/**
 * Renderer for plugin find-and-replace actions — currently the
 * google-workspace `docs.find_and_replace` action. These arrive as
 * `call_tool` invocations with `args.tool_id` naming the action and
 * `args.params` carrying `findText`/`replaceText`, which is a before/after
 * pair — so the body shows a computed diff instead of raw params.
 */

const FIND_REPLACE_TOOL_IDS = new Set(["docs.find_and_replace"]);

interface CallToolArgs {
  tool_id?: unknown;
  params?: unknown;
}

interface FindReplaceParams {
  documentId?: unknown;
  findText?: unknown;
  replaceText?: unknown;
}

function getParams(args: unknown): FindReplaceParams {
  if (!args || typeof args !== "object") return {};
  const p = (args as CallToolArgs).params;
  return p && typeof p === "object" ? (p as FindReplaceParams) : {};
}

function getStr(args: unknown, key: keyof FindReplaceParams): string {
  const v = getParams(args)[key];
  return typeof v === "string" ? v : "";
}

export function isFindReplaceCallTool(toolName: string, args?: unknown): boolean {
  if (toolName !== "call_tool") return false;
  if (!args || typeof args !== "object") return false;
  const toolId = (args as CallToolArgs).tool_id;
  return typeof toolId === "string" && FIND_REPLACE_TOOL_IDS.has(toolId);
}

function occurrences(result: unknown): number | undefined {
  const data = parsedResultData(result);
  const n = data?.occurrencesChanged;
  return typeof n === "number" ? n : undefined;
}

export const findReplaceRenderer: ToolRenderer = {
  matches: isFindReplaceCallTool,
  category: "edit",
  Icon: Replace,
  formatTarget: (args) => getStr(args, "documentId") || undefined,
  formatSummary: (args, result, status) => {
    if (status === "running") return undefined;
    const n = occurrences(result);
    if (n !== undefined) return `${n} replaced`;
    return formatDiffStats(getStr(args, "findText"), getStr(args, "replaceText"));
  },
  Body: ({ args, status, result, error }) => {
    const before = getStr(args, "findText");
    const after = getStr(args, "replaceText");
    const n = occurrences(result);

    return (
      <ToolBody className="px-0 py-0">
        {status === "running" ? (
          <div className="px-3 py-2 text-[11px] text-muted italic font-mono">replacing…</div>
        ) : (
          <DiffView before={before} after={after} />
        )}
        {n !== undefined && (
          <div className="px-3 py-1.5 border-t border-[--border]/60 text-[11px] text-muted font-mono">
            {n} {n === 1 ? "occurrence" : "occurrences"} replaced
          </div>
        )}
        {status === "error" && error && (
          <div className="px-3 py-2 border-t border-danger-500/30 bg-danger-500/5 text-[11px] text-danger-700 dark:text-danger-400 font-mono whitespace-pre-wrap">
            {error}
          </div>
        )}
      </ToolBody>
    );
  },
};
