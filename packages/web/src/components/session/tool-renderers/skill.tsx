import { BookMarked } from "lucide-react";
import { MarkdownBody } from "./markdown-view";
import { ToolBody, ToolShell } from "./tool-shell";
import { resultText, type ToolRenderer } from "./types";

/**
 * Renderer for the `skill` tool — the model's read-a-skill request. The
 * result text is the skill's markdown body, so it renders as a document
 * with a source toggle, exactly like mem_read.
 *
 * The same card also renders a slash-command skill invocation: the command
 * dispatcher expands `/skill:name` into a `<skill name="...">…</skill>`
 * block inside the USER message text (engine `commands/dispatch.ts`).
 * `parseSkillBlock` recognizes that block and `SkillInvocationBlock` shows
 * it through this renderer's Body, so both paths look identical in the
 * transcript instead of the user bubble dumping the full skill markdown.
 */

function getName(args: unknown): string {
  if (!args || typeof args !== "object") return "";
  const n = (args as { name?: unknown }).name;
  return typeof n === "string" ? n : "";
}

export const skillRenderer: ToolRenderer = {
  matches: "skill",
  category: "read",
  Icon: BookMarked,
  formatTarget: (args) => getName(args) || undefined,
  formatSummary: (_args, result, status) => {
    if (status !== "completed") return undefined;
    const lines = resultText(result).split("\n").length;
    return `${lines} ${lines === 1 ? "line" : "lines"}`;
  },
  Body: ({ status, result, error }) => {
    const text = resultText(result);

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
        <MarkdownBody text={text} />
      </ToolBody>
    );
  },
};

/** A `<skill name="...">…</skill>` block parsed out of user message text. */
export interface SkillBlock {
  name: string;
  content: string;
  /** Text after the closing tag — the arguments the user typed after the
   *  slash command. Empty string when the command had none. */
  rest: string;
}

/**
 * Matches the exact shape the command dispatcher emits: the block starts
 * the message, the closing tag sits on its own line, and any user
 * arguments follow after one blank line. Anchored at both ends so a
 * message that merely QUOTES a skill block mid-prose stays plain text.
 * Lazy content match: a skill body that itself contains a literal
 * `\n</skill>` line would split early — no real skill does.
 */
const SKILL_BLOCK_RE = /^<skill name="([^"\n]+)">\n([\s\S]*?)\n<\/skill>(?:\n\n([\s\S]*))?$/;

/**
 * Parse a dispatcher-expanded skill invocation out of user message text.
 * Returns null for anything that is not exactly one leading skill block.
 * Exported for tests.
 */
export function parseSkillBlock(text: string): SkillBlock | null {
  const m = SKILL_BLOCK_RE.exec(text);
  if (!m) return null;
  return { name: m[1], content: m[2], rest: m[3]?.trim() ?? "" };
}

/**
 * The transcript card for a slash-command skill invocation. Synthesizes
 * the props the `skill` tool renderer expects (the block's body as the
 * tool result), so the user-invoked path and the model-invoked path render
 * through one component. Trailing user arguments are the caller's to
 * render — they are the user's actual prompt, not part of the skill.
 */
export function SkillInvocationBlock({ block }: { block: SkillBlock }) {
  const args = { name: block.name };
  const result = { text: block.content };
  return (
    <ToolShell
      toolName="skill"
      category={skillRenderer.category}
      Icon={skillRenderer.Icon}
      target={skillRenderer.formatTarget(args, "skill")}
      summary={skillRenderer.formatSummary?.(args, result, "completed", "skill")}
      status="completed"
    >
      <skillRenderer.Body args={args} result={result} status="completed" toolName="skill" />
    </ToolShell>
  );
}
