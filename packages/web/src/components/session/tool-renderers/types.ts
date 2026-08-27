import type { LucideIcon } from "lucide-react";
import type { FC } from "react";

/**
 * Visual category — drives the colored left strip + accent for status pulses.
 * Categories group tools by *what they do*, not by their plugin source, so a
 * stripe.create_charge that has "destructive write" semantics can use the
 * same `write` category as our built-in write tool.
 */
export type ToolCategory =
  | "shell" // bash, exec, run-command — terminal-green
  | "read" // read, fetch, query — informational blue
  | "write" // write, create, post — additive green
  | "edit" // edit, patch, modify — amber
  | "thread" // thread_read, mailbox, inbox — violet
  | "generic"; // unknown plugin tools — neutral

/**
 * `streaming` = the model is still generating this call's args (live-plane
 * only, synthesized from `tool_call_update` frames). `running` = the tool
 * is executing with complete args.
 */
export type ToolStatus = "streaming" | "running" | "completed" | "error";

export interface ToolRendererProps {
  args: unknown;
  result: unknown;
  status: ToolStatus;
  error?: string;
  /**
   * The tool the model actually called. One plugin action can arrive under
   * more than one name — through `call_tool`, or through a pinned direct
   * tool that carries the action id in its own name — and the two shapes
   * put the parameters in different places, so a renderer that claims both
   * has to know which it got.
   */
  toolName: string;
}

export interface ToolRenderer {
  /**
   * Tool names this renderer handles. String for exact match, array for
   * multiple, or function for prefix/regex/etc. matching (e.g. plugin
   * registers `stripe.*` to its own renderer). The function form also
   * receives the call's args, so a renderer can claim a subset of a shared
   * tool — e.g. `call_tool` invocations whose `tool_id` is `workflows.*`.
   */
  matches: string | string[] | ((toolName: string, args?: unknown) => boolean);
  category: ToolCategory;
  Icon: LucideIcon;
  /**
   * One-liner shown in the collapsed header strip (right of the tool name).
   * Returns the most recognisable identifier for this tool call — usually
   * a path, command excerpt, or first key of args. `toolName` is the trailing
   * argument so a renderer that does not need it can ignore it.
   */
  formatTarget(args: unknown, toolName: string): string | undefined;
  /**
   * Optional compact summary shown on the far right of the header
   * (e.g. "42 lines", "exit 0", "3 messages").
   */
  formatSummary?(
    args: unknown,
    result: unknown,
    status: ToolStatus,
    toolName: string,
  ): string | undefined;
  /** Body view rendered when expanded. */
  Body: FC<ToolRendererProps>;
  /**
   * Opt in to rendering the Body while args are still streaming
   * (`status === "streaming"`, args partial and possibly jagged — every
   * field may be absent or truncated mid-value). Renderers that leave this
   * unset hold their body until the args are complete, matching the
   * pre-streaming behavior.
   */
  streamsArgs?: boolean;
}

/**
 * Whether the Body should render for this status. The only held state is
 * `streaming` on a renderer that didn't opt in via `streamsArgs`.
 */
export function showsLiveBody(renderer: ToolRenderer, status: ToolStatus): boolean {
  return status !== "streaming" || renderer.streamsArgs === true;
}

/** The call is still in flight (args generating or tool executing). */
export function isActiveStatus(status: ToolStatus): boolean {
  return status === "streaming" || status === "running";
}

export function matches(renderer: ToolRenderer, toolName: string, args?: unknown): boolean {
  const m = renderer.matches;
  if (typeof m === "string") return m === toolName;
  if (Array.isArray(m)) return m.includes(toolName);
  return m(toolName, args);
}

/**
 * Header summary for a text-document result: "N lines", or undefined for
 * empty text so the header never contradicts an "(empty)" body
 * (`"".split("\n").length` is 1, not 0).
 */
export function lineCountSummary(text: string): string | undefined {
  if (!text) return undefined;
  const lines = text.split("\n").length;
  return `${lines} ${lines === 1 ? "line" : "lines"}`;
}

/**
 * Extract a printable string from whatever shape the engine persisted as a
 * tool result. We handle three shapes because the persistence layer has
 * shifted under us before:
 *
 *   1. `string` — defensive; some plugins might return raw strings.
 *   2. `{ text: string, …rest }` — the engine's own ToolResult shape and
 *      the new normalized form (we now persist both `text` and the raw
 *      structured fields side-by-side).
 *   3. `{ content: [{ type: "text", text }, …] }` — pi-agent-core's
 *      AgentToolResult shape. Older entries written before the engine
 *      normalized on persist will still have this on disk.
 *
 * Returns "" if no readable text is present (UI renders an "empty output"
 * affordance from there).
 */
export function resultText(result: unknown): string {
  if (typeof result === "string") return result;
  if (!result || typeof result !== "object") return "";
  const r = result as Record<string, unknown>;
  if (typeof r.text === "string") return r.text;
  // pi-agent-core / Anthropic content-block shape.
  if (Array.isArray(r.content)) {
    let out = "";
    for (const block of r.content) {
      if (
        block &&
        typeof block === "object" &&
        (block as { type?: unknown }).type === "text"
      ) {
        const t = (block as { text?: unknown }).text;
        if (typeof t === "string") out += t;
      }
    }
    return out;
  }
  return "";
}
