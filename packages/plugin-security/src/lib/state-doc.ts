import { parse } from "yaml";

/** The protocol version the server validates. protocol/state-doc.md is the
 * contract personas follow; bump both together. */
export const PROTOCOL_VERSION = 1;

export type StateDocStatus = "working" | "yielding" | "done";

/** A persona's parsed state doc (the YAML at /cells/<dir>/state.yml). */
export interface StateDoc {
  protocolVersion: number;
  engagement?: string;
  cell?: string;
  persona?: string;
  mode?: string;
  status: StateDocStatus;
  checklist: { pending: number; done: number };
  queue: { pending: number; done: number };
  findings: string[];
  log: string[];
}

const CORRECTIVE = "Write state.yml again following /protocol.md.";

/**
 * Parse a state doc. Throws an Error with a corrective message on
 * unparseable YAML, an unknown protocol_version, a missing or invalid
 * status, or non-number pending/done counts. Missing checklist/queue
 * blocks default to zero counts; missing findings/log default to [].
 */
export function parseStateDoc(content: string): StateDoc {
  let raw: unknown;
  try {
    raw = parse(content);
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    throw new Error(`state.yml is not valid YAML (${detail}). ${CORRECTIVE}`);
  }
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new Error(`state.yml must be a YAML map. ${CORRECTIVE}`);
  }
  const doc = raw as Record<string, unknown>;

  const protocolVersion = doc.protocol_version;
  if (protocolVersion !== PROTOCOL_VERSION) {
    throw new Error(
      `state.yml has protocol_version ${String(protocolVersion)}; the only known version is ${PROTOCOL_VERSION}. ${CORRECTIVE}`,
    );
  }

  const status = doc.status;
  if (status !== "working" && status !== "yielding" && status !== "done") {
    throw new Error(
      `state.yml has status "${String(status)}"; use working, yielding, or done. ${CORRECTIVE}`,
    );
  }

  return {
    protocolVersion: PROTOCOL_VERSION,
    engagement: optionalString(doc.engagement),
    cell: optionalString(doc.cell),
    persona: optionalString(doc.persona),
    mode: optionalString(doc.mode),
    status,
    checklist: parseCounts(doc.checklist, "checklist"),
    queue: parseCounts(doc.queue, "queue"),
    findings: parseStringList(doc.findings, "findings"),
    log: parseStringList(doc.log, "log"),
  };
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function parseCounts(value: unknown, block: string): { pending: number; done: number } {
  if (value === undefined || value === null) return { pending: 0, done: 0 };
  if (typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`state.yml ${block} must be a map with pending and done counts. ${CORRECTIVE}`);
  }
  const counts = value as Record<string, unknown>;
  return {
    pending: parseCount(counts.pending, `${block}.pending`),
    done: parseCount(counts.done, `${block}.done`),
  };
}

function parseCount(value: unknown, field: string): number {
  if (value === undefined || value === null) return 0;
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`state.yml ${field} is ${JSON.stringify(value)}, not a number. ${CORRECTIVE}`);
  }
  return value;
}

function parseStringList(value: unknown, field: string): string[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string")) {
    throw new Error(`state.yml ${field} must be a list of text entries. ${CORRECTIVE}`);
  }
  return value.filter((entry): entry is string => typeof entry === "string");
}

/** How sec_cell_complete rules on a settled cell's latest state doc. */
export type ExitRuling =
  | { outcome: "done" }
  | { outcome: "yielded" }
  | { outcome: "violation"; violation: string };

/**
 * Rule on a state doc's exit condition. `yielding` is a deliberate stop;
 * `done` completes only when both pending counts are zero; anything else
 * is a violation whose message names the exact field and value so the
 * runner can steer the persona.
 */
export function ruleExit(doc: StateDoc): ExitRuling {
  if (doc.status === "yielding") return { outcome: "yielded" };
  if (doc.status === "working") {
    return {
      outcome: "violation",
      violation: "status is working — write a final state doc with status done or yielding",
    };
  }
  if (doc.checklist.pending !== 0) {
    return {
      outcome: "violation",
      violation: `status is done but checklist.pending is ${doc.checklist.pending}, not 0`,
    };
  }
  if (doc.queue.pending !== 0) {
    return {
      outcome: "violation",
      violation: `status is done but queue.pending is ${doc.queue.pending}, not 0`,
    };
  }
  return { outcome: "done" };
}
