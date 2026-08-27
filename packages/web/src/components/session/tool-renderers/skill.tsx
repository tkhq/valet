import { BookMarked } from "lucide-react";
import { parseSkillBlock, sliceSkillBlock, type SkillBlock } from "@valet/shared";
import type { MessageSkillInvocation } from "@valet/api/wire";
import { cn } from "~/lib/cn";
import { KeyValueTable } from "./fallback";
import { MarkdownBody } from "./markdown-view";
import { CopyButton, ToolBody } from "./tool-shell";
import { lineCountSummary, resultText, type ToolRenderer } from "./types";

/**
 * Renderer for the `skill` tool — the model's read-a-skill request
 * (packages/api/src/plugins/skill-tool.ts). The result text is the skill's
 * markdown body, so it renders as a document with a source toggle.
 *
 * The producer returns failures as completed-status TEXT with a stable
 * prefix (`[skill_not_found]`, `[skill_bad_args]`) so the model can
 * self-correct without aborting the turn. The card must not dress those
 * up as successful reads: they render danger-toned with no line count.
 *
 * The same card renders a user's slash-command skill invocation — see
 * `extractSkillInvocation` below and `SkillInvocationBlock` in
 * message-item.tsx.
 */

const SKILL_FAILURE_RE = /^\[skill_(not_found|bad_args)\]/;

function getName(args: unknown): string {
  if (!args || typeof args !== "object") return "";
  const n = (args as { name?: unknown }).name;
  return typeof n === "string" ? n : "";
}

/** The placeholder-value record the model passed, when present. */
function getArgsRecord(args: unknown): [string, unknown][] {
  if (!args || typeof args !== "object") return [];
  const rec = (args as { args?: unknown }).args;
  if (!rec || typeof rec !== "object" || Array.isArray(rec)) return [];
  return Object.entries(rec as Record<string, unknown>);
}

export const skillRenderer: ToolRenderer = {
  matches: "skill",
  category: "read",
  Icon: BookMarked,
  formatTarget: (args) => getName(args) || undefined,
  formatSummary: (_args, result, status) => {
    if (status !== "completed") return undefined;
    const text = resultText(result);
    if (SKILL_FAILURE_RE.test(text)) return "failed";
    return lineCountSummary(text);
  },
  Body: ({ args, status, result, error }) => {
    const text = resultText(result);
    const failed = status === "error" || SKILL_FAILURE_RE.test(text);
    const argEntries = getArgsRecord(args);

    if (status === "running") {
      return (
        <ToolBody>
          <span className="text-muted italic font-mono text-[11px]">reading…</span>
        </ToolBody>
      );
    }
    if (failed || !text) {
      const message = error || text || "(no output)";
      return (
        <ToolBody>
          <div className="flex items-start justify-between gap-2">
            <span
              className={cn(
                "font-mono text-[11px] whitespace-pre-wrap break-words min-w-0",
                failed ? "text-danger-700 dark:text-danger-400" : "text-muted",
              )}
            >
              {message}
            </span>
            {failed && (
              <CopyButton label="Copy error" getText={() => message} className="-mt-0.5 shrink-0" />
            )}
          </div>
        </ToolBody>
      );
    }
    return (
      <ToolBody className="px-0 py-0">
        {argEntries.length > 0 && (
          <div className="px-3 py-2 border-b border-[--border]/60">
            <KeyValueTable entries={argEntries} />
          </div>
        )}
        <MarkdownBody text={text} />
      </ToolBody>
    );
  },
};

/**
 * Recover a skill invocation from user message text, in fidelity order:
 *
 * 1. Wire metadata + exact slice — delimiter-proof (`sliceSkillBlock`).
 * 2. Wire metadata, unwrapped text — a host `Thread.skill()` submission:
 *    the whole text IS the rendered skill body.
 * 3. No metadata (legacy rows): anchored best-effort regex.
 *
 * Callers gate on `role === "user"` — the stamp only ever rides a queue
 * item onto a user entry, and assistant prose that quotes a block must
 * stay prose.
 */
export function extractSkillInvocation(
  text: string,
  meta?: MessageSkillInvocation,
): SkillBlock | null {
  if (!text) return null;
  if (meta) {
    const sliced = sliceSkillBlock(text, meta.name, meta.args ?? "");
    if (sliced) return sliced;
    return { name: meta.name, content: text, rest: "" };
  }
  return parseSkillBlock(text);
}

export type { SkillBlock };
