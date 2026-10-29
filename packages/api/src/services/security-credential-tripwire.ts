import { Buffer } from "node:buffer";
import { recordSecurityCredentialFragmentAlert } from "../observability/security-metrics.js";

const BLOCKED =
  "[security_error] Credential output was blocked before it could be stored or sent. " +
  "Use the credential through its launcher command; never print, echo, or encode the value.";

/**
 * Shortest run of characters the tripwire tracks across atoms.
 *
 * A persona can split a credential over several tool results, so the
 * tripwire remembers which positions of each registered value the session
 * has already emitted. It only remembers runs of this length or longer.
 * The minimum exists because shorter runs mark common characters as
 * covered, and ordinary source output then completes a value it never
 * carried.
 *
 * The residual, stated exactly. A fragment shorter than this length is
 * invisible to coverage. A copy of the value with one character altered
 * every eighth position carries no run this long, so it raises neither a
 * block nor an alert. A copy altered every ninth position stays at eight
 * ninths covered, which is under BLOCK_FRACTION, so it raises the alert
 * and does not block. The compensating controls for that residual are the
 * launcher contract, which keeps the value out of persona-readable
 * output, and rotation in 1Password after the engagement.
 */
export const MIN_CREDENTIAL_FRAGMENT = 8;

/** Covered fraction at which one encoded form raises an alert, once. */
const ALERT_FRACTION = 0.5;

/**
 * Covered fraction at which one encoded form blocks. Full coverage is the
 * obvious case, but a copy with one character altered never reaches it and
 * is still a leak of everything but that character.
 */
const BLOCK_FRACTION = 0.9;

/**
 * Candidate positions examined per text position.
 *
 * One window can start at very many positions of a repetitive value: every
 * even position of "a" repeated 8000 times carries the same window. Without
 * a cap the scan would examine all of them at every text position. The cap
 * bounds that. Positions are taken round-robin across candidates, so a
 * repetitive value sharing a window with another value cannot use the whole
 * budget and starve it.
 */
const MAX_WINDOW_HITS = 8;

interface Candidate {
  value: string;
  /** One byte per character of `value`: 1 once the session emitted it. */
  coverage: Uint8Array;
  covered: number;
}

/** Where one window starts inside one candidate. */
interface WindowGroup {
  candidate: Candidate;
  positions: number[];
}

interface Variant {
  /** Whole values, for the contiguous check. */
  values: Set<string>;
  tracked: Map<string, Candidate>;
  /**
   * Every window of MIN_CREDENTIAL_FRAGMENT characters across all values.
   * Positions are grouped by candidate so the scan can take them
   * round-robin instead of in registration order.
   */
  index: Map<string, WindowGroup[]>;
}

/** What the tripwire reports when one encoded form passes half covered. */
export interface SecurityCredentialFragmentAlert {
  sessionId: string;
  engagementId: string;
}

/** Where a session sends its fragment alerts. */
export interface RegisterSecurityCredentialOptions {
  onAlert?: (event: SecurityCredentialFragmentAlert) => void;
}

interface MatchSet {
  engagementId: string;
  plain: Variant;
  compact: Variant;
  /**
   * Encoded forms that already raised the alert. Keyed by the form, not the
   * candidate: the plain value is a candidate in both variants, and it
   * alerts once.
   */
  alerted: Set<string>;
  onAlert: (event: SecurityCredentialFragmentAlert) => void;
}

interface Update {
  candidate: Candidate;
  coverage: Uint8Array;
  covered: number;
}

const bySession = new Map<string, MatchSet>();

function newVariant(): Variant {
  return { values: new Set(), tracked: new Map(), index: new Map() };
}

/**
 * The forms of one value the tripwire matches. Each form is one transform
 * of the value, never a transform of another form. Compression and ciphers
 * stay the residual, because their output shares no run with the value.
 *
 * Only the `indexed` forms carry a coverage index, so only they are
 * tracked across atoms. Every other form gets the whole-value check only,
 * because an index costs memory per character and the `\u` form alone is
 * six times the length of the value.
 */
function encodings(value: string): { indexed: string[]; whole: string[] } {
  const bytes = Buffer.from(value, "utf8");
  const hex = bytes.toString("hex");
  // `xxd -p | sed 's/../%&/g'` emits lowercase hex and encoders emit
  // uppercase, so both cases match.
  const percent = [...bytes].map((b) => `%${b.toString(16).toUpperCase().padStart(2, "0")}`).join("");
  // JSON escapes one UTF-16 unit at a time, in the lowercase hex that
  // JSON.stringify and Python's json module emit.
  let jsonEscapes = "";
  for (let at = 0; at < value.length; at += 1) {
    jsonEscapes += `\\u${value.charCodeAt(at).toString(16).padStart(4, "0")}`;
  }
  return {
    indexed: [value, bytes.toString("base64"), bytes.toString("base64url")],
    whole: [
      encodeURIComponent(value),
      hex,
      hex.toUpperCase(),
      [...value].reverse().join(""),
      value.toUpperCase(),
      value.toLowerCase(),
      percent,
      percent.toLowerCase(),
      jsonEscapes,
      [...value].map((c) => `&#${c.codePointAt(0)};`).join(""),
    ],
  };
}

/** The text of one atom, and the base64 data of its image blocks apart. */
interface Output {
  text: string;
  images: string[];
}

const BASE64_ALPHABET = /^[A-Za-z0-9+/=_-]*$/;

/**
 * The base64 data of an image content block, or undefined. The block is the
 * shape pi-ai's ImageContent has: `type: "image"`, an `image/` mimeType, and
 * base64 data. A look-alike without those fields is ordinary text, so a
 * structured result cannot route fragments around the coverage scan.
 *
 * Image data gets the whole-value check only. It is pixels the tripwire
 * cannot read, and a coverage scan over megabytes of base64 stalls the api
 * event loop. A file of raw credential bytes read as an image still carries
 * the whole base64 value, so the whole-value check still catches it.
 */
function imageData(item: object): string | undefined {
  if (!("type" in item) || item.type !== "image") return undefined;
  if (!("mimeType" in item) || typeof item.mimeType !== "string") return undefined;
  if (!item.mimeType.startsWith("image/")) return undefined;
  if (!("data" in item) || typeof item.data !== "string") return undefined;
  return BASE64_ALPHABET.test(item.data) ? item.data : undefined;
}

/** Collect an atom's string leaves; image block data goes to `images`. */
function outputText(value: unknown): Output {
  if (typeof value === "string") return { text: value, images: [] };
  const fragments: string[] = [];
  const images: string[] = [];
  const visit = (item: unknown): void => {
    if (typeof item === "string") {
      fragments.push(item);
      return;
    }
    // Binary data carries no string leaves.
    if (ArrayBuffer.isView(item)) return;
    if (Array.isArray(item)) {
      for (const child of item) visit(child);
      return;
    }
    if (item !== null && typeof item === "object") {
      const data = imageData(item);
      if (data !== undefined) images.push(data);
      for (const [key, child] of Object.entries(item)) {
        if (data === undefined || key !== "data") visit(child);
      }
    }
  };
  visit(value);
  return { text: fragments.join(""), images };
}

function compact(value: string): string {
  return value.replace(/[\t\n\f\r ]/g, "");
}

/**
 * Add one form to a variant. With `index`, the form is also tracked for
 * coverage across atoms.
 *
 * A form of exactly MIN_CREDENTIAL_FRAGMENT characters has one window,
 * which is the whole form. The whole-value check already blocks that in
 * both readings of an atom, so such a form carries no coverage index.
 */
function addValue(variant: Variant, value: string, { index }: { index: boolean }): void {
  variant.values.add(value);
  if (!index || value.length <= MIN_CREDENTIAL_FRAGMENT) return;
  if (variant.tracked.has(value)) return;
  const candidate: Candidate = {
    value,
    coverage: new Uint8Array(value.length),
    covered: 0,
  };
  variant.tracked.set(value, candidate);
  for (let at = 0; at + MIN_CREDENTIAL_FRAGMENT <= value.length; at += 1) {
    const window = value.slice(at, at + MIN_CREDENTIAL_FRAGMENT);
    const groups = variant.index.get(window);
    if (!groups) {
      variant.index.set(window, [{ candidate, positions: [at] }]);
      continue;
    }
    // One call adds every position of one candidate, so this candidate's
    // group, if it exists, is the last one.
    const last = groups[groups.length - 1];
    if (last.candidate === candidate) last.positions.push(at);
    else groups.push({ candidate, positions: [at] });
  }
}

/**
 * Register one value resolved for a running security persona session.
 *
 * `onAlert` is the seam a caller uses to watch the fragment alert. It
 * defaults to the counter and log line the api ships.
 */
export function registerSecurityCredentialValue(
  sessionId: string,
  engagementId: string,
  value: string,
  options?: RegisterSecurityCredentialOptions,
): void {
  // A value this short is ordinary text, and the tripwire cannot tell it
  // from source output. Preflight refuses short secrets.
  if (value.length < MIN_CREDENTIAL_FRAGMENT) return;
  let entry = bySession.get(sessionId);
  if (!entry || entry.engagementId !== engagementId) {
    entry = {
      engagementId,
      plain: newVariant(),
      compact: newVariant(),
      alerted: new Set(),
      onAlert: options?.onAlert ?? recordSecurityCredentialFragmentAlert,
    };
    bySession.set(sessionId, entry);
  } else if (options?.onAlert) {
    entry.onAlert = options.onAlert;
  }
  const { indexed, whole } = encodings(value);
  for (const [forms, index] of [[indexed, true], [whole, false]] as const) {
    for (const form of forms) {
      addValue(entry.plain, form, { index });
      // POSIX and GNU base64 can wrap output, and fold or sed can split the
      // value itself, so each form also matches with ASCII whitespace
      // removed. A form that stripping shortened to the minimum or less is
      // skipped: "pass word" strips to the ordinary word "password".
      const stripped = compact(form);
      if (stripped === form || stripped.length > MIN_CREDENTIAL_FRAGMENT) {
        addValue(entry.compact, stripped, { index });
      }
    }
  }
}

/** One reading of an atom, plus the same reading with whitespace removed. */
interface Reading {
  text: string;
  compacted: string;
}

/**
 * The whole-value check. It runs over two readings of the same atom: the
 * serialized payload, which keeps the structure a reader would see, and
 * the concatenated string leaves, which is what a value split across two
 * fields of one object looks like. JSON escaping separates those two
 * readings, so both are needed.
 */
function directMatch(entry: MatchSet, readings: Reading[]): boolean {
  for (const reading of readings) {
    for (const candidate of entry.plain.values) {
      if (reading.text.includes(candidate)) return true;
    }
    for (const candidate of entry.compact.values) {
      if (reading.compacted.includes(candidate)) return true;
    }
  }
  return false;
}

/**
 * Slide one window over `text`, and for every indexed hit extend the match
 * forward while the characters agree, then mark the run covered.
 *
 * Each candidate consumes each character of the text once: `consumed`
 * holds the text position a candidate has already extended over. A hit
 * whose whole window lies inside that stretch is skipped, because the run
 * it would walk was walked already. Without that, a text built from near
 * copies of a value walks the same run once per starting offset, which
 * costs the length of the text times the length of the value and stalls
 * the api event loop for seconds.
 *
 * A hit that only PARTLY overlaps the consumed stretch is still taken. It
 * is the shape a persona gets by deleting characters from the middle of a
 * value: the run from the front absorbs the first character after the cut,
 * and the next window starts one position inside it while pointing at a
 * different, uncovered part of the value. Dropping those hits would leave
 * the whole tail uncovered.
 *
 * A repetitive value can still lose coverage it would earn on an
 * overlapping run that starts inside a run already walked. That is the
 * accepted price of walking each character once.
 *
 * Nothing is written back: the caller commits only when the atom is not
 * blocked.
 */
function scanVariant(variant: Variant, text: string): { updates: Update[]; blocking: boolean } {
  const updates = new Map<Candidate, Update>();
  const consumed = new Map<Candidate, number>();
  const limit = text.length - MIN_CREDENTIAL_FRAGMENT;
  for (let at = 0; at <= limit; at += 1) {
    const groups = variant.index.get(text.slice(at, at + MIN_CREDENTIAL_FRAGMENT));
    if (groups === undefined) continue;
    let taken = 0;
    // Round-robin: every candidate holding this window gets a position
    // before any candidate gets a second one.
    for (let round = 0; taken < MAX_WINDOW_HITS; round += 1) {
      let served = false;
      for (const group of groups) {
        if (round >= group.positions.length) continue;
        served = true;
        const candidate = group.candidate;
        const position = group.positions[round];
        const already = consumed.get(candidate) ?? 0;
        taken += 1;
        if (already - at >= MIN_CREDENTIAL_FRAGMENT) {
          if (taken >= MAX_WINDOW_HITS) break;
          continue;
        }
        const value = candidate.value;
        let run = MIN_CREDENTIAL_FRAGMENT;
        while (
          position + run < value.length &&
          at + run < text.length &&
          text[at + run] === value[position + run]
        ) {
          run += 1;
        }
        if (at + run > already) consumed.set(candidate, at + run);
        let update = updates.get(candidate);
        if (!update) {
          update = {
            candidate,
            coverage: candidate.coverage.slice(),
            covered: candidate.covered,
          };
          updates.set(candidate, update);
        }
        for (let mark = position; mark < position + run; mark += 1) {
          if (update.coverage[mark] === 1) continue;
          update.coverage[mark] = 1;
          update.covered += 1;
        }
        if (taken >= MAX_WINDOW_HITS) break;
      }
      if (!served) break;
    }
  }
  const list = [...updates.values()];
  return {
    updates: list,
    blocking: list.some((u) => u.covered >= u.candidate.value.length * BLOCK_FRACTION),
  };
}

function commit(sessionId: string, entry: MatchSet, updates: Update[]): void {
  for (const update of updates) {
    const candidate = update.candidate;
    candidate.coverage = update.coverage;
    candidate.covered = update.covered;
    if (entry.alerted.has(candidate.value)) continue;
    if (candidate.covered / candidate.value.length < ALERT_FRACTION) continue;
    entry.alerted.add(candidate.value);
    entry.onAlert({ sessionId, engagementId: entry.engagementId });
  }
}

/**
 * True when this atom must be blocked. A blocked atom is never remembered;
 * an allowed one commits its coverage, so calling this twice with the same
 * atom leaves the same coverage.
 */
function blocks(sessionId: string, entry: MatchSet, value: unknown, output: Output): boolean {
  const { text, images } = output;
  // The replacer reads the holder, not `v`: Buffer.toJSON runs before the
  // replacer and turns the view into a plain array of numbers.
  const serialized =
    typeof value === "string"
      ? value
      : JSON.stringify(value, function (this: Record<string, unknown>, key: string, v: unknown) {
          if (ArrayBuffer.isView(this[key])) return undefined;
          return key === "data" && imageData(this) !== undefined ? undefined : v;
        });
  const serializedText = typeof serialized === "string" ? serialized : "";
  const compactText = compact(text);
  const readings: Reading[] = [{ text, compacted: compactText }];
  if (serializedText !== text) {
    readings.push({ text: serializedText, compacted: compact(serializedText) });
  }
  // Image data gets the whole-value check only: see `imageData`.
  for (const data of images) readings.push({ text: data, compacted: compact(data) });
  if (directMatch(entry, readings)) return true;
  const plain = scanVariant(entry.plain, text);
  const compacted = scanVariant(entry.compact, compactText);
  if (plain.blocking || compacted.blocking) return true;
  commit(sessionId, entry, plain.updates);
  commit(sessionId, entry, compacted.updates);
  return false;
}

/** Replace an output atom when it contains or completes a registered value. */
export function sanitizeSecurityCredentialOutput(sessionId: string, value: unknown): unknown {
  const entry = bySession.get(sessionId);
  if (!entry) return value;
  let output: Output;
  try {
    output = outputText(value);
  } catch {
    return BLOCKED;
  }
  return blocks(sessionId, entry, value, output) ? BLOCKED : value;
}

export function assertNoSecurityCredentialOutput(sessionId: string, value: unknown): void {
  const entry = bySession.get(sessionId);
  if (!entry) return;
  let output: Output;
  try {
    output = outputText(value);
  } catch {
    throw new Error(BLOCKED);
  }
  if (blocks(sessionId, entry, value, output)) throw new Error(BLOCKED);
}

export function hasSecurityCredentialValues(sessionId: string): boolean {
  return bySession.has(sessionId);
}

export function clearSecurityCredentialSession(sessionId: string): void {
  bySession.delete(sessionId);
}

export const SECURITY_CREDENTIAL_OUTPUT_BLOCKED = BLOCKED;
