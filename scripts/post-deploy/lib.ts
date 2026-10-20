/**
 * Pure library behind `scripts/post-deploy.ts` (`make post-deploy`): config
 * parsing, polling, and report rendering. No network and no fs here, so
 * everything is unit-testable (`lib.test.ts`).
 *
 * Runbook: docs/testing/post-deploy-journeys.md
 */

export type JourneyStatus = "passed" | "failed" | "skipped";

/** One fact a journey observed, printed as `key: value` under its row. */
export interface Evidence {
  key: string;
  value: string;
}

export interface JourneyResult {
  id: string;
  title: string;
  status: JourneyStatus;
  durationMs: number;
  evidence: Evidence[];
  /** Why it failed or was skipped. */
  reason?: string;
  /** Cleanup steps that did not finish: the operator removes these by hand. */
  leftovers: string[];
}

export interface Report {
  url: string;
  build: string | null;
  startedAt: string;
  journeys: JourneyResult[];
  passed: number;
  failed: number;
  skipped: number;
  exitCode: number;
}

const ICON: Record<JourneyStatus, string> = { passed: "✓", failed: "✗", skipped: "⊘" };

export function toReport(input: { url: string; build: string | null; startedAt: string; journeys: JourneyResult[] }): Report {
  const count = (s: JourneyStatus) => input.journeys.filter((j) => j.status === s).length;
  const failed = count("failed");
  return { ...input, passed: count("passed"), failed, skipped: count("skipped"), exitCode: failed > 0 ? 1 : 0 };
}

/** The human report: one row per journey, its evidence indented below. */
export function renderReport(report: Report): string {
  const lines = [`Valet post-deploy journeys: ${report.url}`, `build: ${report.build ?? "unknown"}  started: ${report.startedAt}`, ""];
  const width = Math.max(...report.journeys.map((j) => j.id.length), 1);
  for (const j of report.journeys) {
    const secs = (j.durationMs / 1000).toFixed(1);
    const tail = j.status === "skipped" ? `skipped: ${j.reason ?? "no reason given"}` : `${j.status} (${secs}s)`;
    lines.push(`${ICON[j.status]} ${j.id.padEnd(width)}  ${tail}`);
    lines.push(`    ${j.title}`);
    if (j.status === "failed" && j.reason) lines.push(`    reason: ${j.reason}`);
    for (const e of j.evidence) lines.push(`    ${e.key}: ${e.value}`);
    for (const l of j.leftovers) lines.push(`    LEFTOVER: ${l}`);
  }
  lines.push("");
  lines.push(`${report.passed} passed · ${report.failed} failed · ${report.skipped} skipped`);
  return lines.join("\n");
}

/** `--only a,b`: keep the listed ids in table order; throw on an unknown id. */
export function selectJourneys<T extends { id: string }>(all: T[], only?: string[]): T[] {
  if (!only || only.length === 0) return all;
  const known = new Set(all.map((j) => j.id));
  for (const id of only) {
    if (!known.has(id)) throw new Error(`Unknown journey "${id}". Run with --list to see the journey ids.`);
  }
  const wanted = new Set(only);
  return all.filter((j) => wanted.has(j.id));
}

/** Text that marks an error as a transport or server fault, not a message written for a person. */
const RAW_ERROR = /\b(HTTP [45]\d\d|Internal Server Error|fetch failed|ECONN\w*|ETIMEDOUT|socket hang up|\[object Object\]|undefined|TypeError|stack)\b/i;

/**
 * Why an integration error is not a clear, named error, or null when it is.
 * A clear error names the integration (its service id or label) and has no
 * raw transport or server text.
 */
export function unclearErrorReason(text: string, names: string[]): string | null {
  const trimmed = text.trim();
  if (trimmed === "") return "the error text is empty";
  const raw = RAW_ERROR.exec(trimmed);
  if (raw) return `the error shows raw server text ("${raw[0]}")`;
  const lower = trimmed.toLowerCase();
  if (!names.some((n) => n !== "" && lower.includes(n.toLowerCase()))) return `the error does not name the integration (${names.join(" or ")})`;
  return null;
}

export interface PollOptions {
  timeoutMs: number;
  intervalMs: number;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

export class PollTimeout extends Error {
  constructor(
    readonly what: string,
    readonly waitedMs: number,
    readonly last: unknown,
  ) {
    super(`Timed out after ${Math.round(waitedMs / 1000)}s waiting for ${what}.`);
  }
}

/**
 * Call `read` until `done(value)` holds, and return that value. On timeout,
 * throw PollTimeout carrying the last value read, so the report can show
 * the state the journey saw last.
 */
export async function pollUntil<T>(what: string, read: () => Promise<T>, done: (value: T) => boolean, opts: PollOptions): Promise<T> {
  const now = opts.now ?? Date.now;
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const start = now();
  let last: T | undefined;
  for (;;) {
    last = await read();
    if (done(last)) return last;
    const waited = now() - start;
    if (waited >= opts.timeoutMs) throw new PollTimeout(what, waited, last);
    await sleep(Math.min(opts.intervalMs, opts.timeoutMs - waited));
  }
}
