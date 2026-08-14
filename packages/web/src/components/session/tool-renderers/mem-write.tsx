import { BookPlus } from "lucide-react";
import { MarkdownBody } from "./markdown-view";
import { PathLabel, ToolBody } from "./tool-shell";
import { resultText, type ToolRenderer } from "./types";

/**
 * Renderer for the orchestrator's `mem_write` tool. `content` is the full
 * markdown body of the memory file, so it renders as markdown with a
 * source toggle. A call without `content` is a metadata-only update — the
 * body shows the metadata fields instead.
 */

interface MemWriteArgs {
  path?: unknown;
  content?: unknown;
}

/** Metadata fields worth echoing for a metadata-only update. */
const META_KEYS = ["type", "description", "tags", "resource", "sensitivity", "origin", "expires", "pinned"] as const;

function getStr(args: unknown, key: keyof MemWriteArgs): string {
  if (!args || typeof args !== "object") return "";
  const v = (args as MemWriteArgs)[key];
  return typeof v === "string" ? v : "";
}

function metaEntries(args: unknown): Array<[string, string]> {
  if (!args || typeof args !== "object") return [];
  const rec = args as Record<string, unknown>;
  const out: Array<[string, string]> = [];
  for (const key of META_KEYS) {
    const v = rec[key];
    // null is a meaningful op (expires: null clears the expiry) but
    // rendering the literal "null" reads as a bug — show it as "cleared".
    if (v === undefined) continue;
    if (v === null) {
      out.push([key, "cleared"]);
      continue;
    }
    out.push([key, Array.isArray(v) ? v.join(", ") : String(v)]);
  }
  return out;
}

export const memWriteRenderer: ToolRenderer = {
  matches: "mem_write",
  category: "write",
  Icon: BookPlus,
  formatTarget: (args) => getStr(args, "path") || undefined,
  formatSummary: (args, _result, status) => {
    if (status === "running") return undefined;
    const content = getStr(args, "content");
    if (!content) return "metadata";
    const lines = content.split("\n").length;
    return `+${lines} ${lines === 1 ? "line" : "lines"}`;
  },
  Body: ({ args, status, result, error }) => {
    const path = getStr(args, "path");
    const content = getStr(args, "content");
    const failed = status === "error";

    return (
      <ToolBody className="px-0 py-0">
        {status === "running" ? (
          <div className="px-3 py-2 text-[11px] text-muted italic font-mono">writing…</div>
        ) : content ? (
          <MarkdownBody text={content} left={path ? <PathLabel path={path} /> : undefined} />
        ) : (
          <div className="px-3 py-2 font-mono text-[11px]">
            {path && (
              <div className="mb-1.5">
                <PathLabel path={path} />
              </div>
            )}
            <dl className="grid grid-cols-[max-content_1fr] gap-x-3 gap-y-0.5">
              {metaEntries(args).map(([k, v]) => (
                <div key={k} className="contents">
                  <dt className="text-muted">{k}</dt>
                  <dd className="text-[--fg]/85 break-words">{v}</dd>
                </div>
              ))}
            </dl>
          </div>
        )}
        {failed && (error || resultText(result)) && (
          <div className="px-3 py-2 border-t border-danger-500/30 bg-danger-500/5 text-[11px] text-danger-700 dark:text-danger-400 font-mono whitespace-pre-wrap">
            {error || resultText(result)}
          </div>
        )}
      </ToolBody>
    );
  },
};
