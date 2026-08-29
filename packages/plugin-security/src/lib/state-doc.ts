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

/** Every top-level key the schema allows. Any other key is a typo or a
 * hallucinated field — the strict parse rejects it by name. */
export const STATE_DOC_KEYS: readonly string[] = [
  "protocol_version",
  "engagement",
  "cell",
  "persona",
  "mode",
  "status",
  "checklist",
  "queue",
  "findings",
  "log",
];

/** The keys a state doc MUST carry. `engagement` and `mode` are optional. */
const REQUIRED_KEYS: readonly string[] = [
  "protocol_version",
  "cell",
  "persona",
  "status",
  "checklist",
  "queue",
  "findings",
  "log",
];

const STATUS_VALUES: readonly string[] = ["working", "yielding", "done"];
const MODE_VALUES: readonly string[] = ["fresh", "resume"];

/** Joins a violation list into one corrective the persona can act on in a
 * single rewrite — every problem named at once, not whack-a-mole. */
function formatViolations(violations: readonly string[]): string {
  const body = violations.map((v) => `  - ${v}`).join("\n");
  return `state.yml has ${violations.length} problem(s):\n${body}\n${CORRECTIVE}`;
}

/** Strict structural validation of a state doc's raw content. Returns every
 * violation (not just the first) so the persona fixes them all in one rewrite,
 * plus the parsed {@link StateDoc} when the structure is sound enough to build
 * one. Identity (cell/persona match) and finding-id existence are checked by
 * the caller, which holds the acting cell and the database. */
export function collectStateDocViolations(content: string): {
  doc: StateDoc | null;
  violations: string[];
} {
  let raw: unknown;
  try {
    raw = parse(content);
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    return { doc: null, violations: [`not valid YAML (${detail})`] };
  }
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return { doc: null, violations: ["the document must be a YAML map"] };
  }
  const doc = raw as Record<string, unknown>;
  const violations: string[] = [];

  // Unknown keys — a typo (`checklsit`) or a hallucinated field never passes.
  for (const key of Object.keys(doc)) {
    if (!STATE_DOC_KEYS.includes(key)) {
      violations.push(
        `unknown key "${key}". The only allowed keys are: ${STATE_DOC_KEYS.join(", ")}`,
      );
    }
  }
  // Required keys present.
  for (const key of REQUIRED_KEYS) {
    if (!(key in doc)) violations.push(`missing required key "${key}"`);
  }

  if (doc.protocol_version !== PROTOCOL_VERSION) {
    violations.push(
      `protocol_version must be ${PROTOCOL_VERSION} (got ${JSON.stringify(doc.protocol_version)})`,
    );
  }

  const status = doc.status;
  if (typeof status !== "string" || !STATUS_VALUES.includes(status)) {
    violations.push(`status must be one of ${STATUS_VALUES.join(", ")} (got ${JSON.stringify(status)})`);
  }

  if ("mode" in doc && (typeof doc.mode !== "string" || !MODE_VALUES.includes(doc.mode))) {
    violations.push(`mode must be one of ${MODE_VALUES.join(", ")} (got ${JSON.stringify(doc.mode)})`);
  }

  // Identity fields must be non-empty strings (the caller checks they MATCH the
  // acting cell — here we only reject a blank or non-string value).
  for (const key of ["cell", "persona"] as const) {
    if (key in doc && (typeof doc[key] !== "string" || (doc[key] as string).trim() === "")) {
      violations.push(`"${key}" must be a non-empty string (got ${JSON.stringify(doc[key])})`);
    }
  }
  if ("engagement" in doc && typeof doc.engagement !== "string") {
    violations.push(`"engagement" must be a string (got ${JSON.stringify(doc.engagement)})`);
  }

  const checklist = strictCounts(doc.checklist, "checklist", violations);
  const queue = strictCounts(doc.queue, "queue", violations);
  const findings = strictStringList(doc.findings, "findings", violations);
  const log = strictStringList(doc.log, "log", violations);

  // Exit consistency at WRITE time: `done` is a claim the counts must back.
  if (status === "done") {
    if (checklist.pending !== 0) {
      violations.push(`status is done but checklist.pending is ${checklist.pending}, not 0`);
    }
    if (queue.pending !== 0) {
      violations.push(`status is done but queue.pending is ${queue.pending}, not 0`);
    }
  }

  // A doc that survived the hard-shape checks (status is a valid enum) can still
  // build a StateDoc for the caller's identity/finding checks even when other
  // fields violated — those violations still surface. A doc with an invalid
  // status cannot build one.
  const built: StateDoc | null =
    typeof status === "string" && STATUS_VALUES.includes(status)
      ? {
          protocolVersion: PROTOCOL_VERSION,
          engagement: optionalString(doc.engagement),
          cell: optionalString(doc.cell),
          persona: optionalString(doc.persona),
          mode: optionalString(doc.mode),
          status: status as StateDocStatus,
          checklist,
          queue,
          findings,
          log,
        }
      : null;

  return { doc: built, violations };
}

/**
 * Parse a state doc, throwing a single corrective that names EVERY structural
 * violation at once. Strict: rejects unknown keys, missing required keys, a
 * wrong protocol_version, an invalid status or mode, non-integer or negative
 * counts, a non-string-list findings/log, and a `done` status whose pending
 * counts are not zero. Identity (cell/persona) and finding-id existence are the
 * write path's job — see the service `writeFile`.
 */
export function parseStateDoc(content: string): StateDoc {
  const { doc, violations } = collectStateDocViolations(content);
  if (violations.length > 0 || doc === null) {
    throw new Error(formatViolations(violations.length > 0 ? violations : ["the document could not be parsed"]));
  }
  return doc;
}

/**
 * Identity violations: the doc's `cell` and `persona` MUST name the cell that
 * is writing it. The recon persona that copies the protocol example (or another
 * cell's doc, or hallucinates a `verifier`/`06-verify` doc) is caught here — the
 * commonest way a persona wanders off its own rails. Returns every mismatch.
 */
export function stateDocIdentityViolations(
  doc: StateDoc,
  expected: { cell: string; persona: string },
): string[] {
  const violations: string[] = [];
  if (doc.cell !== expected.cell) {
    violations.push(
      `cell is ${JSON.stringify(doc.cell ?? null)} but you are writing the state doc for cell "${expected.cell}". ` +
        `Set "cell: ${expected.cell}". Write YOUR OWN state doc — never copy the protocol example or another cell's doc.`,
    );
  }
  if (doc.persona !== expected.persona) {
    violations.push(
      `persona is ${JSON.stringify(doc.persona ?? null)} but your persona is "${expected.persona}". ` +
        `Set "persona: ${expected.persona}".`,
    );
  }
  return violations;
}

/** Compose a single corrective from a write path's full violation list
 * (structural + identity + finding-id existence). Exported so the service and
 * its tests format the message one way. */
export function stateDocWriteError(violations: readonly string[]): string {
  return formatViolations(violations);
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

/** Strict counts: `pending` and `done` must both be present, integer, and
 * >= 0. A missing block or a float/negative/non-number count is a violation. */
function strictCounts(
  value: unknown,
  block: string,
  violations: string[],
): { pending: number; done: number } {
  if (value === undefined || value === null) {
    violations.push(`${block} is missing — write a map with integer pending and done counts`);
    return { pending: 0, done: 0 };
  }
  if (typeof value !== "object" || Array.isArray(value)) {
    violations.push(`${block} must be a map with pending and done counts (got ${JSON.stringify(value)})`);
    return { pending: 0, done: 0 };
  }
  const counts = value as Record<string, unknown>;
  return {
    pending: strictCount(counts.pending, `${block}.pending`, violations),
    done: strictCount(counts.done, `${block}.done`, violations),
  };
}

function strictCount(value: unknown, field: string, violations: string[]): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
    violations.push(`${field} must be an integer >= 0 (got ${JSON.stringify(value)})`);
    return 0;
  }
  return value;
}

function strictStringList(value: unknown, field: string, violations: string[]): string[] {
  if (value === undefined || value === null) {
    violations.push(`${field} is missing — write a list (use [] when empty)`);
    return [];
  }
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string")) {
    violations.push(`${field} must be a list of text entries (got ${JSON.stringify(value)})`);
    return [];
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
