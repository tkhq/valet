/**
 * OKF (Open Knowledge Format) serialization — canonical YAML frontmatter +
 * markdown body, in both directions. One module owns the format; every
 * boundary (memory service read/write, HTTP export/import) goes through it.
 *
 * FORMAT ONLY. This module targets the OKF v0.1 shape (frontmatter key
 * order, canonical YAML emission, virtual index.md, reserved-name /
 * path-depth rules) as re-landed for the clean-slate owner-tuple memory
 * core (Phase 4 decision 12). It deliberately does NOT implement the
 * legacy spec's links graph, mem_move, expiry sweeps, relevance boosting,
 * shareable-export filtering, reranker, or tag-similarity hints — those
 * are out of scope for this phase (see docs/plans/2026-07-13-engine-v2-
 * phase-4-orchestrator.md, decision 12).
 *
 * The DB is the source of truth; frontmatter is a deterministic
 * projection rendered at every boundary. The stored `content` column
 * holds only the plain markdown body.
 */
import { Document, Scalar, YAMLMap, YAMLSeq, isMap, isSeq, parseDocument } from "yaml";

// ─── Types ───────────────────────────────────────────────────────────────

/** Denylist — extras can never shadow a known OKF/valet key (render would
 * emit a duplicate YAML key otherwise). */
const RESERVED_FRONTMATTER_KEYS = new Set([
  "type",
  "title",
  "description",
  "resource",
  "tags",
  "timestamp",
  "valet",
]);

const KNOWN_VALET_KEYS = new Set(["sensitivity", "origin", "expires"]);

/** The shape `renderConcept` needs. Callers (the memory service) build this
 * from a `memory_files` row plus the request's owner-scope timestamp. */
export interface RenderableConcept {
  type: string;
  title: string;
  description: string;
  resource: string;
  tags: string[];
  /** Rendered as `timestamp`, ISO 8601 `Z`. */
  updatedAtMs: number;
  /** Rendered under `valet:` only when != 'private'. */
  sensitivity: string;
  /** Rendered under `valet:` only when non-empty. */
  origin: string;
  /** Rendered under `valet:` (ISO 8601 `Z`) only when set. */
  expiresMs: number | null;
  /** Unknown frontmatter keys captured on a prior parse, preserved
   * as-written (see Canonical YAML emission policy). Sorted at render. */
  extras: Record<string, string>;
  /** Plain markdown body — never includes frontmatter. */
  content: string;
}

/** What `parseConcept` extracts from a raw OKF document. Tolerant: a
 * missing/malformed frontmatter block or missing `type` never throws —
 * the whole input is treated as the body with empty metadata. */
export interface ParsedConcept {
  hasFrontmatter: boolean;
  type: string;
  title: string;
  description: string;
  resource: string;
  tags: string[];
  /** Raw ISO-ish string as found in the document, or '' if absent. Callers
   * normalize/interpret (e.g. for stale-echo comparisons). */
  timestamp: string;
  valet: {
    sensitivity?: string;
    origin?: string;
    expires?: string;
  };
  /** Unknown `valet.*` sub-keys found and dropped, e.g. `"valet.pinned"`. */
  droppedValetKeys: string[];
  /** Unknown top-level (non-valet, non-reserved) keys, as-written scalar
   * source text. */
  extras: Record<string, string>;
  /** Everything after the frontmatter block (or the whole input, if none). */
  body: string;
}

// ─── Path rules (decision 12 / OKF spec "Reserved names & path rules") ────

export const MAX_MEMORY_PATH_DEPTH = 5;

export class ReservedPathError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ReservedPathError";
  }
}

/**
 * Strip leading `/`, collapse `//`, reject `..`/empty segments and colons.
 * A single trailing `/` is preserved (it's the directory-path marker used
 * by `readFile`) — everything else empty is rejected. Throws
 * `ReservedPathError` on any structurally invalid path; this runs before
 * the reserved-name checks below, which only apply to agent/API writes
 * (never imports — imports remap instead).
 */
export function normalizePath(path: string): string {
  const p0 = path.trim();
  if (p0.includes(":")) {
    throw new ReservedPathError(`invalid path "${path}": colons are not allowed in stored paths`);
  }
  let p = p0.replace(/^\/+/, "").replace(/\/{2,}/g, "/");
  if (p.length === 0) {
    throw new ReservedPathError(`invalid path "${path}": empty path`);
  }

  const isDirMarker = p.endsWith("/") && p !== "/";
  const checkSegments = (isDirMarker ? p.slice(0, -1) : p).split("/");
  if (checkSegments.some((s) => s === "..")) {
    throw new ReservedPathError(`invalid path "${path}": ".." is not allowed`);
  }
  if (checkSegments.some((s) => s.length === 0)) {
    throw new ReservedPathError(`invalid path "${path}": empty path segment`);
  }

  return p;
}

/** Reserved-name / depth rules — agent and API writes only, never imports
 * (imports remap; see `remapImportPath`). Rejections carry the OKF spec's
 * verbatim remediation strings. */
export function assertWritablePath(path: string): void {
  const normalized = normalizePath(path);
  if (normalized.endsWith("/")) {
    throw new ReservedPathError(`invalid path "${path}": cannot write to a directory path`);
  }
  const segments = normalized.split("/");
  const basename = segments[segments.length - 1];

  if (basename === "index.md" || basename === "log.md") {
    throw new ReservedPathError("index.md is auto-generated for directories — use overview.md instead");
  }
  if (segments[0] === "lib") {
    throw new ReservedPathError("lib/ is reserved for mounted libraries — write under notes/ or projects/");
  }
  if (normalized === "graph") {
    // /memory/graph is the explorer's graph-view URL and shadows the
    // /memory/$ doc route — a root file named "graph" would be unreachable.
    throw new ReservedPathError('"graph" is reserved for the memory graph view — add an extension or a directory');
  }
  if (segments.length > MAX_MEMORY_PATH_DEPTH) {
    throw new ReservedPathError(`path exceeds ${MAX_MEMORY_PATH_DEPTH} levels — flatten under projects/<name>/`);
  }
}

/** Import-only remap: never rejects. `lib/` → `imported-lib/`, over-deep
 * paths flatten under their last `MAX_MEMORY_PATH_DEPTH` segments (keeping
 * the basename), reserved basenames get a `-imported` suffix. Returns the
 * remapped path; the caller records `original !== remapped` as a remap. */
export function remapImportPath(path: string): string {
  let normalized: string;
  try {
    normalized = normalizePath(path);
  } catch {
    // Fall back to a slug-safe path when normalization itself fails
    // (e.g. embedded ".."). Imports never reject on path shape.
    normalized = path
      .replace(/^\/+/, "")
      .replace(/\.\./g, "")
      .replace(/:/g, "")
      .replace(/\/+/g, "/");
    if (normalized.length === 0) normalized = "imported.md";
  }

  let segments = normalized.split("/");
  if (segments[0] === "lib") {
    segments = ["imported-lib", ...segments.slice(1)];
  }

  if (segments.length > MAX_MEMORY_PATH_DEPTH) {
    const basename = segments[segments.length - 1];
    const dir = segments.slice(0, -1).slice(0, MAX_MEMORY_PATH_DEPTH - 1);
    segments = [...dir, basename];
  }

  const basename = segments[segments.length - 1];
  if (basename === "index.md") {
    segments[segments.length - 1] = "index-imported.md";
  } else if (basename === "log.md") {
    segments[segments.length - 1] = "log-imported.md";
  }

  // Root-level "graph" would be URL-shadowed by the graph view (see
  // assertWritablePath) — remap so the imported doc stays reachable.
  if (segments.length === 1 && segments[0] === "graph") {
    segments[0] = "graph-imported";
  }

  return segments.join("/");
}

// ─── Canonical YAML emission ────────────────────────────────────────────

function buildFrontmatterObject(c: RenderableConcept): Record<string, unknown> {
  const fm: Record<string, unknown> = {};
  fm.type = c.type;
  if (c.title !== "") fm.title = c.title;
  if (c.description !== "") fm.description = c.description;
  if (c.resource !== "") fm.resource = c.resource;
  if (c.tags.length > 0) fm.tags = c.tags;
  fm.timestamp = new Date(c.updatedAtMs).toISOString();

  const valet: Record<string, unknown> = {};
  if (c.sensitivity !== "private" && c.sensitivity !== "") valet.sensitivity = c.sensitivity;
  if (c.origin !== "") valet.origin = c.origin;
  if (c.expiresMs != null) valet.expires = new Date(c.expiresMs).toISOString();
  if (Object.keys(valet).length > 0) fm.valet = valet;

  for (const key of Object.keys(c.extras).sort()) {
    if (RESERVED_FRONTMATTER_KEYS.has(key)) continue; // denylist — never emit a dup key
    fm[key] = c.extras[key];
  }

  return fm;
}

/**
 * Renders frontmatter + stored body — nothing else (no derived content
 * ever; export and read share this function). Key order fixed: `type,
 * title, description, resource, tags, timestamp`, then `valet:` (only
 * when non-empty), then sorted extras keys. Empty optionals omitted.
 */
export function renderConcept(c: RenderableConcept): string {
  const fm = buildFrontmatterObject(c);
  const doc = new Document(fm);

  const tagsNode = doc.get("tags", true);
  if (isSeq(tagsNode)) (tagsNode as YAMLSeq).flow = true;

  const yamlText = doc.toString({
    defaultStringType: "QUOTE_DOUBLE",
    defaultKeyType: "PLAIN",
    lineWidth: 0,
    singleQuote: false,
    // Force single-line double-quoted scalars with `\n`-escaped newlines
    // rather than YAML's line-folding style — canonical policy requires
    // "escaped newlines", not multi-line folded quoted scalars.
    doubleQuotedAsJSON: true,
    flowCollectionPadding: false,
  });

  const body = c.content ?? "";
  return `---\n${yamlText}---\n\n${body}`;
}

// ─── Parsing ─────────────────────────────────────────────────────────────

/** Extract the as-written source text of a scalar node, bypassing YAML's
 * plain-scalar type coercion (so `NO` stays the string `"NO"`, `1.10`
 * stays `"1.10"` rather than collapsing to the float 1.1). Quoted scalars
 * use the decoded JS value (already unambiguously a string); plain
 * scalars use their raw source text. Non-scalar values fall back to a
 * JSON-stringified projection (tolerant — extras are expected to be
 * scalars in practice). */
function scalarSourceText(node: unknown): string {
  if (node instanceof Scalar) {
    const parsed = node as Scalar.Parsed;
    if (parsed.type === Scalar.PLAIN && typeof parsed.source === "string") {
      return parsed.source;
    }
    const value = node.toJSON();
    return typeof value === "string" ? value : String(value);
  }
  if (isMap(node) || isSeq(node)) {
    return JSON.stringify(node.toJSON());
  }
  return String(node);
}

function stringField(map: YAMLMap, key: string): string {
  const v = map.get(key, false);
  if (v == null) return "";
  if (typeof v === "string") return v;
  return String(v);
}

function tagsField(map: YAMLMap): string[] {
  const raw = map.get("tags", false);
  const v = isSeq(raw) ? raw.toJSON() : raw;
  if (!Array.isArray(v)) return [];
  return v.map((x) => (typeof x === "string" ? x : String(x)));
}

/** Attempts to split a leading `---\n ... \n---` frontmatter block from
 * `text`. Returns `null` when there is no well-formed leading block (e.g.
 * a body that merely starts with a markdown horizontal rule `---`) — the
 * caller then treats the entire input as body with no frontmatter. Never
 * throws; a YAML parse error is treated the same as "no frontmatter". */
function splitFrontmatter(text: string): { yamlText: string; body: string } | null {
  if (!text.startsWith("---\n") && text !== "---" && !text.startsWith("---\r\n")) return null;

  const firstNewline = text.indexOf("\n");
  if (firstNewline === -1) return null;
  const rest = text.slice(firstNewline + 1);

  // Find a line that is exactly "---" (the closing fence), scanning line by
  // line so we never mistake a `---` appearing inside a scalar value.
  const lines = rest.split("\n");
  let closeLineIdx = -1;
  for (let i = 0; i < lines.length; i++) {
    if (lines[i] === "---" || lines[i] === "...") {
      closeLineIdx = i;
      break;
    }
  }
  if (closeLineIdx === -1) return null;

  const yamlText = lines.slice(0, closeLineIdx).join("\n");
  let bodyLines = lines.slice(closeLineIdx + 1);
  // A single blank separator line right after the closing fence is part of
  // the frontmatter block's own formatting, not body content.
  if (bodyLines[0] === "") bodyLines = bodyLines.slice(1);
  const body = bodyLines.join("\n");

  return { yamlText, body };
}

/**
 * Splits frontmatter from body; maps known keys per the disposition table;
 * unknown non-`valet` keys → extras. Tolerant per OKF: missing frontmatter
 * or missing `type` never fails. Unknown `valet.*` sub-keys are dropped
 * and reported via `droppedValetKeys` — the caller decides whether/how to
 * surface that (write/import response warnings).
 */
export function parseConcept(text: string): ParsedConcept {
  const empty: ParsedConcept = {
    hasFrontmatter: false,
    type: "",
    title: "",
    description: "",
    resource: "",
    tags: [],
    timestamp: "",
    valet: {},
    droppedValetKeys: [],
    extras: {},
    body: text,
  };

  const split = splitFrontmatter(text);
  if (!split) return empty;

  let doc: ReturnType<typeof parseDocument>;
  try {
    doc = parseDocument(split.yamlText, { keepSourceTokens: true, strict: false });
  } catch {
    return empty;
  }
  if (doc.errors.length > 0) return empty;

  const map = doc.contents;
  if (!isMap(map)) return empty;

  const result: ParsedConcept = {
    hasFrontmatter: true,
    type: stringField(map, "type"),
    title: stringField(map, "title"),
    description: stringField(map, "description"),
    resource: stringField(map, "resource"),
    tags: tagsField(map),
    timestamp: stringField(map, "timestamp"),
    valet: {},
    droppedValetKeys: [],
    extras: {},
    body: split.body,
  };

  const valetNode = map.get("valet", true);
  if (isMap(valetNode)) {
    for (const pair of valetNode.items) {
      const key = String((pair.key as Scalar | string | number)?.toString?.() ?? pair.key);
      if (KNOWN_VALET_KEYS.has(key)) {
        const val = scalarSourceRawValue(pair.value);
        if (key === "sensitivity") result.valet.sensitivity = val;
        else if (key === "origin") result.valet.origin = val;
        else if (key === "expires") result.valet.expires = val;
      } else {
        result.droppedValetKeys.push(`valet.${key}`);
      }
    }
  }

  for (const pair of map.items) {
    const key = String((pair.key as Scalar | string | number)?.toString?.() ?? pair.key);
    if (RESERVED_FRONTMATTER_KEYS.has(key)) continue;
    result.extras[key] = scalarSourceText(pair.value);
  }

  return result;
}

/** Like `scalarSourceText` but returns the decoded value for known
 * `valet.*` fields (sensitivity/origin/expires are always plain strings
 * we control the vocabulary of — no coercion risk). */
function scalarSourceRawValue(node: unknown): string {
  if (node instanceof Scalar) {
    const value = node.toJSON();
    return typeof value === "string" ? value : String(value);
  }
  return String(node);
}

/**
 * Strips a leading frontmatter block from `text`, returning the plain
 * body. This is intentionally narrow: the legacy OKF spec's fenced-block
 * machinery (backlinks/expiry-notice decorations) is out of scope for
 * this phase (decision 12) — `sanitizeBody` only ever strips frontmatter.
 */
export function sanitizeBody(text: string): string {
  return parseConcept(text).body;
}
