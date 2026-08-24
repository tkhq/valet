/**
 * Renderer for the design_* tool family (Valet Design spec §Tools):
 * design_edit, design_render_token, design_comment_resolve, plus the
 * future design_import_*, design_export, and design_handoff. One renderer
 * for the family — the calls differ only in which arg names the target.
 */
import { Palette } from "lucide-react";
import { ToolBody, TruncatedText } from "./tool-shell";
import { resultText, type ToolRenderer } from "./types";

function str(args: unknown, key: string): string | undefined {
  if (!args || typeof args !== "object") return undefined;
  const v = (args as Record<string, unknown>)[key];
  return typeof v === "string" && v.length > 0 ? v : undefined;
}

/** The most recognisable identifier per design tool. */
export function formatDesignTarget(args: unknown, toolName: string): string | undefined {
  switch (toolName) {
    case "design_edit": {
      const kind = str(args, "kind");
      const summary = str(args, "summary");
      if (kind && summary) return `${kind} — ${summary}`;
      return kind ?? summary;
    }
    case "design_render_token":
      return str(args, "token_name");
    case "design_comment_resolve":
      return str(args, "vdid");
    case "design_export":
      return str(args, "format");
    case "design_import_marp":
    case "design_import_image":
      return str(args, "file_path");
    case "design_import_gslides":
      return str(args, "presentation_id");
    case "design_handoff":
      return str(args, "implementation_task");
    default:
      return str(args, "summary") ?? str(args, "kind");
  }
}

export const designRenderer: ToolRenderer = {
  matches: (toolName) => toolName.startsWith("design_"),
  category: "write",
  Icon: Palette,
  formatTarget: formatDesignTarget,
  Body: ({ result, status, error }) => {
    const text = error ?? resultText(result);
    return (
      <ToolBody>
        {status === "running" || status === "streaming" ? (
          <div className="text-[11px] text-muted italic font-mono">working…</div>
        ) : text ? (
          <TruncatedText
            text={text}
            className={error ? "text-danger-700 dark:text-danger-400" : undefined}
          />
        ) : (
          <div className="text-[11px] text-muted italic font-mono">(no output)</div>
        )}
      </ToolBody>
    );
  },
};
