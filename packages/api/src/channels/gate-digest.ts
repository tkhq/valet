/**
 * Digest a decision gate into channel-renderable pieces.
 *
 * A tool-approval gate's `body` is a machine-oriented dump — the summary
 * line plus `tool_id=…` and `args={json}` (see `approvalGateRequest` in
 * `@valet/engine`). Posting that verbatim to a channel buries the decision
 * under a JSON blob. This module rebuilds the prompt from the gate's
 * structured `context` instead: a one-line summary body plus labeled
 * fields, which each transport renders natively.
 *
 * Both gate-prompt senders (the channel-thread card in `host.ts` and the
 * attention DM in `attention-wiring.ts`) go through here, so the two copies
 * of one gate always show the same facts.
 *
 * Gates without tool context (e.g. `ask_approval`, question gates) pass
 * through untouched — their title/body were written for humans already.
 */
import type { DecisionGate } from "@valet/engine";

export interface GateField {
  label: string;
  value: string;
}

export interface GateDigest {
  title: string;
  /** Markdown body without the raw JSON dump. */
  body?: string;
  fields?: GateField[];
}

/** Slack renders at most 10 fields per section; leave room for Tool + Risk. */
const MAX_ARG_FIELDS = 8;
/** Fields are for scanning, not reading — the web session has the full args. */
const MAX_VALUE_CHARS = 120;

function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

/**
 * One markdown value per arg. Scalars render plain; structured values render
 * as single-line JSON in inline code. Either way the value is bounded — a
 * reader who needs the full payload opens the session in Valet.
 */
function argValue(value: unknown): string {
  if (typeof value === "string") return truncate(value, MAX_VALUE_CHARS);
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (value === null) return "null";
  return `\`${truncate(JSON.stringify(value) ?? "", MAX_VALUE_CHARS)}\``;
}

export function digestGate(gate: Pick<DecisionGate, "type" | "title" | "body" | "context">): GateDigest {
  const ctx = gate.context;
  const toolId = typeof ctx?.tool_id === "string" ? ctx.tool_id : undefined;
  if (gate.type !== "approval" || toolId === undefined) {
    return { title: gate.title, body: gate.body };
  }

  const fields: GateField[] = [{ label: "Tool", value: `\`${toolId}\`` }];
  const riskLevel = ctx?.riskLevel;
  if (typeof riskLevel === "string" && riskLevel !== "") {
    fields.push({ label: "Risk", value: riskLevel });
  }

  const args = ctx?.args;
  if (args !== null && typeof args === "object" && !Array.isArray(args)) {
    const entries = Object.entries(args as Record<string, unknown>).filter(([, v]) => v !== undefined);
    for (const [key, value] of entries.slice(0, MAX_ARG_FIELDS)) {
      fields.push({ label: key, value: argValue(value) });
    }
    const overflow = entries.length - MAX_ARG_FIELDS;
    if (overflow > 0) {
      fields.push({ label: "More", value: `+${overflow} more parameter${overflow === 1 ? "" : "s"} in Valet` });
    }
  }

  const summary = typeof ctx?.summary === "string" && ctx.summary.trim() !== "" ? ctx.summary.trim() : undefined;
  return { title: gate.title, body: summary, fields };
}
