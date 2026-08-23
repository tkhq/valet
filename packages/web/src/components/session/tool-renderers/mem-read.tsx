import { BookOpen } from "lucide-react";
import { MarkdownBody } from "./markdown-view";
import { useMemoryViewer } from "./memory-viewer";
import { PathLabel, ToolBody } from "./tool-shell";
import { resultText, type ToolRenderer } from "./types";

/**
 * Renderer for the orchestrator's `mem_read` tool. The result text is the
 * rendered memory document (or a markdown directory index for paths ending
 * in "/"), so it renders as markdown by default with a source toggle.
 * Cross-references and the expand action open the memory viewer dialog
 * in place (`useMemoryViewer`).
 */

function getPath(args: unknown): string {
  if (!args || typeof args !== "object") return "";
  const p = (args as { path?: unknown }).path;
  return typeof p === "string" ? p : "";
}

export const memReadRenderer: ToolRenderer = {
  matches: "mem_read",
  category: "read",
  Icon: BookOpen,
  formatTarget: (args) => getPath(args) || "/",
  formatSummary: (_args, result, status) => {
    if (status !== "completed") return undefined;
    const lines = resultText(result).split("\n").length;
    return `${lines} ${lines === 1 ? "line" : "lines"}`;
  },
  Body: ({ args, status, result, error }) => {
    const path = getPath(args);
    const text = resultText(result);
    const viewer = useMemoryViewer(path);

    if (status === "running") {
      return (
        <ToolBody>
          <span className="text-muted italic font-mono text-[11px]">reading…</span>
        </ToolBody>
      );
    }
    if (status === "error" || !text) {
      return (
        <ToolBody>
          <span className="text-muted font-mono text-[11px]">
            {error || text || "(empty)"}
          </span>
        </ToolBody>
      );
    }
    return (
      <ToolBody className="px-0 py-0">
        <MarkdownBody
          text={text}
          left={<PathLabel path={path || "/"} />}
          actions={viewer.expandButton}
          memoryLinks={viewer.memoryLinks}
        />
        {viewer.dialog}
      </ToolBody>
    );
  },
};
