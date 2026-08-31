/**
 * Digest a decision gate into channel-renderable pieces.
 *
 * A tool-approval gate's `body` is a machine-oriented dump — the summary
 * line plus `tool_id=…` and `args={json}` (see `approvalGateRequest` in
 * `@valet/engine`). Posting that verbatim to a channel buries the decision
 * under a JSON blob. This module rebuilds the prompt from the gate's
 * structured context instead (narrowed through the engine's
 * `toolApprovalGateContext`, so writer and reader share one shape): a
 * one-line summary body plus labeled fields, which each transport renders
 * natively.
 *
 * Both gate-prompt senders (the channel-thread card in `host.ts` and the
 * attention DM in `attention-wiring.ts`) go through here, so the two copies
 * of one gate always show the same facts.
 *
 * Gates without tool context (e.g. `ask_approval`, question gates) pass
 * through untouched — their title/body were written for humans already.
 *
 * Field labels and values are markdown TEXT, not markup: transports must
 * render them inert (escape, or code-wrap) because arg content is
 * model/third-party controlled. Values arrive bounded; a reader who needs
 * the full payload opens the session in Valet.
 */
import { toolApprovalGateContext, type DecisionGate } from "@valet/engine";

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
/** Labels are arg keys; a runaway key must not blow a transport's field cap. */
const MAX_LABEL_CHARS = 60;

/** Code-point-safe truncation: never splits a surrogate pair at the cap. */
function truncate(text: string, max: number): string {
  const points = [...text];
  return points.length > max ? `${points.slice(0, max - 1).join("")}…` : text;
}

/**
 * One markdown value per arg. Scalars render plain; structured values render
 * as single-line JSON in inline code (embedded backticks swapped for a
 * curly quote so they cannot terminate the code span early).
 */
function argValue(value: unknown): string {
  if (typeof value === "string") return truncate(value, MAX_VALUE_CHARS);
  if (value === null || typeof value === "number" || typeof value === "boolean") return String(value);
  const json = JSON.stringify(value).replaceAll("`", "ʼ");
  return `\`${truncate(json, MAX_VALUE_CHARS)}\``;
}

export function digestGate(gate: Pick<DecisionGate, "type" | "title" | "body" | "context">): GateDigest {
  const ctx = gate.type === "approval" ? toolApprovalGateContext(gate.context) : null;
  if (ctx === null) {
    return { title: gate.title, body: gate.body };
  }

  const fields: GateField[] = [{ label: "Tool", value: `\`${ctx.toolId}\`` }];
  if (ctx.riskLevel !== undefined && ctx.riskLevel !== "") {
    fields.push({ label: "Risk", value: ctx.riskLevel });
  }

  if (ctx.args !== undefined) {
    const entries = Object.entries(ctx.args).filter(([, v]) => v !== undefined);
    for (const [key, value] of entries.slice(0, MAX_ARG_FIELDS)) {
      fields.push({ label: truncate(key, MAX_LABEL_CHARS), value: argValue(value) });
    }
    const overflow = entries.length - MAX_ARG_FIELDS;
    if (overflow > 0) {
      fields.push({ label: "More", value: `+${overflow} more parameter${overflow === 1 ? "" : "s"} in Valet` });
    }
  }

  // A blank summary must not leave the durable notification row (and the
  // card) with no body at all — fall back to naming the requested tool.
  const summary = ctx.summary !== undefined && ctx.summary.trim() !== "" ? ctx.summary.trim() : undefined;
  return { title: gate.title, body: summary ?? `Requested: \`${ctx.toolId}\``, fields };
}
