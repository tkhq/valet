/**
 * OKF v0.1 serialization module.
 *
 * Single module for canonical YAML emission and tolerant parsing of OKF concept
 * frontmatter. Every boundary (mem_read, HTTP API, export) uses this module.
 *
 * Emission policy: hand-rolled emitter, deterministic byte output, fixed key order.
 * Parsing: yaml package document API with keepSourceTokens to capture scalars as-written.
 */

import { parseDocument, isMap, isSeq, isScalar, isPair } from 'yaml';

export const OKF_VERSION = '0.1';

export interface ConceptMeta {
  type: string;
  title: string;
  description: string;
  resource: string;
  tags: string[];
  sensitivity: 'private' | 'shareable';
  origin: string;
  expires: string | null;   // D1 format in, rendered as ISO
  updatedAt: string;        // D1 format in, rendered as ISO `timestamp`
  extras: Record<string, string>; // as-written scalar strings
}

export interface ParsedConcept {
  body: string;
  meta: Partial<ConceptMeta>;         // only keys present in frontmatter
  rawValet: Record<string, string>;   // embedded valet.* sub-keys, as-written
  unknownValetKeys: string[];         // valet.* keys not in the vocabulary
  hadFrontmatter: boolean;
}

// ---------------------------------------------------------------------------
// Temporal conversions
// ---------------------------------------------------------------------------

/** 'YYYY-MM-DD HH:MM:SS' → 'YYYY-MM-DDTHH:MM:SSZ' */
export function toIso(d1: string): string {
  return d1.replace(' ', 'T') + 'Z';
}

/** Tolerant inverse: date-only, offsets, or full ISO all → 'YYYY-MM-DD HH:MM:SS' (UTC) */
export function fromIso(iso: string): string {
  const d = new Date(iso);
  const pad = (n: number) => String(n).padStart(2, '0');
  const y = d.getUTCFullYear();
  const mo = pad(d.getUTCMonth() + 1);
  const dy = pad(d.getUTCDate());
  const h = pad(d.getUTCHours());
  const mi = pad(d.getUTCMinutes());
  const s = pad(d.getUTCSeconds());
  return `${y}-${mo}-${dy} ${h}:${mi}:${s}`;
}

// ---------------------------------------------------------------------------
// Hand-rolled emitter
// ---------------------------------------------------------------------------

/** Double-quote a string: JSON.stringify produces valid YAML 1.2 double-quoted scalar. */
function q(s: string): string {
  return JSON.stringify(s);
}

/**
 * The hard denylist: keys the emitter owns; extras may never shadow them.
 * Checked so that renderConcept never emits a duplicate YAML key.
 */
const RESERVED_KEYS = new Set([
  'type', 'title', 'description', 'resource', 'tags', 'timestamp', 'valet',
]);

const VALET_KNOWN_KEYS = new Set(['sensitivity', 'origin', 'expires']);

export interface RenderConceptOptions {
  /** Skip the `valet:` block entirely (shareable exports must never leak it). */
  omitValet?: boolean;
}

/**
 * Emit a canonical OKF frontmatter + body document.
 *
 * Key order: type, title, description, resource, tags, timestamp,
 * valet: (sensitivity always; origin when non-empty; expires when non-null),
 * then extras keys sorted ascending, each emitted verbatim.
 * With `omitValet: true` the `valet:` block is omitted entirely.
 */
export function renderConcept(meta: ConceptMeta, body: string, opts?: RenderConceptOptions): string {
  const lines: string[] = ['---'];

  // type — always present (required by OKF)
  lines.push(`type: ${q(meta.type)}`);

  // title — omit when empty
  if (meta.title) lines.push(`title: ${q(meta.title)}`);

  // description — omit when empty
  if (meta.description) lines.push(`description: ${q(meta.description)}`);

  // resource — omit when empty
  if (meta.resource) lines.push(`resource: ${q(meta.resource)}`);

  // tags — omit when empty
  if (meta.tags.length > 0) {
    lines.push(`tags: [${meta.tags.map(q).join(', ')}]`);
  }

  // timestamp — always present (derived from updatedAt)
  lines.push(`timestamp: ${q(toIso(meta.updatedAt))}`);

  // valet: block (omitted entirely for shareable exports)
  if (!opts?.omitValet) {
    lines.push('valet:');
    lines.push(`  sensitivity: ${q(meta.sensitivity)}`);
    if (meta.origin) lines.push(`  origin: ${q(meta.origin)}`);
    if (meta.expires !== null) lines.push(`  expires: ${q(toIso(meta.expires))}`);
  }

  // extras — sorted ascending, emitted verbatim (skip any key in the denylist)
  const extrasKeys = Object.keys(meta.extras)
    .filter(k => !RESERVED_KEYS.has(k))
    .sort();
  for (const k of extrasKeys) {
    const v = meta.extras[k];
    // If the value contains a newline, quote it; otherwise emit as-written
    const emitted = v.includes('\n') ? q(v) : v;
    lines.push(`${k}: ${emitted}`);
  }

  lines.push('---');
  return lines.join('\n') + '\n' + body;
}

// ---------------------------------------------------------------------------
// Parser
// ---------------------------------------------------------------------------

/**
 * Get the source text of a scalar node.
 * For plain scalars, srcToken gives the exact source text before YAML parsing.
 * Falls back to String(node.value) when source isn't available.
 */
function scalarSourceText(node: unknown): string {
  if (!isScalar(node)) return '';

  // Access srcToken for the original source text.
  // yaml's CST Scalar type exposes srcToken when keepSourceTokens: true, but
  // this field is absent from the public type declarations — cast is necessary.
  const srcToken = (node as { srcToken?: { source?: string } }).srcToken;
  if (srcToken && typeof srcToken.source === 'string') {
    return srcToken.source;
  }
  // Fallback: use the string value
  return String(node.value ?? '');
}

const KNOWN_TOP_KEYS = new Set([
  'type', 'title', 'description', 'resource', 'tags', 'timestamp', 'valet',
]);

/**
 * Parse an OKF concept document.
 *
 * Tolerant: missing frontmatter or junk YAML never throws — whole input becomes body.
 * Extras scalars are captured as their source text to preserve YAML-1.1 footgun values.
 */
export function parseConcept(doc: string): ParsedConcept {
  const empty: ParsedConcept = {
    body: doc,
    meta: {},
    rawValet: {},
    unknownValetKeys: [],
    hadFrontmatter: false,
  };

  // Frontmatter detection: must start with '---\n' and have a closing '\n---\n'
  if (!doc.startsWith('---\n')) return empty;

  const closeIdx = doc.indexOf('\n---\n', 4);
  if (closeIdx === -1) return empty;

  const fmText = doc.slice(4, closeIdx); // content between the delimiters
  const body = doc.slice(closeIdx + 5);  // after '\n---\n'

  let yamlDoc: ReturnType<typeof parseDocument>;
  try {
    yamlDoc = parseDocument(fmText, { schema: 'core', keepSourceTokens: true });
  } catch {
    return empty;
  }

  // If the document has errors that prevent map access, treat as no frontmatter
  if (!isMap(yamlDoc.contents)) {
    // Could be null (empty FM) — that's valid: empty meta, body as extracted
    return {
      body,
      meta: {},
      rawValet: {},
      unknownValetKeys: [],
      hadFrontmatter: true,
    };
  }

  const meta: Partial<ConceptMeta> = {};
  const rawValet: Record<string, string> = {};
  const unknownValetKeys: string[] = [];
  const extras: Record<string, string> = {};

  for (const pair of yamlDoc.contents.items) {
    if (!isPair(pair)) continue;
    const key = isScalar(pair.key) ? String(pair.key.value ?? '') : String(pair.key);

    if (!KNOWN_TOP_KEYS.has(key)) {
      // extras — capture as-written (preserves YAML-1.1 footgun values like NO, 022, ~)
      extras[key] = scalarSourceText(pair.value);
      continue;
    }

    switch (key) {
      case 'type':
        meta.type = isScalar(pair.value) ? String(pair.value.value ?? '') : '';
        break;
      case 'title':
        meta.title = isScalar(pair.value) ? String(pair.value.value ?? '') : '';
        break;
      case 'description':
        meta.description = isScalar(pair.value) ? String(pair.value.value ?? '') : '';
        break;
      case 'resource':
        meta.resource = isScalar(pair.value) ? String(pair.value.value ?? '') : '';
        break;
      case 'timestamp': {
        const ts = isScalar(pair.value) ? String(pair.value.value ?? '') : '';
        meta.updatedAt = fromIso(ts);
        break;
      }
      case 'tags': {
        const node = pair.value;
        if (isSeq(node)) {
          meta.tags = node.items
            .filter(isScalar)
            .map(s => String(s.value ?? ''));
        }
        break;
      }
      case 'valet': {
        const node = pair.value;
        if (!isMap(node)) break;
        for (const vPair of node.items) {
          if (!isPair(vPair)) continue;
          const vKey = isScalar(vPair.key) ? String(vPair.key.value ?? '') : String(vPair.key);
          // Use the interpreted scalar value (not source text) for known semantic keys so
          // that renderConcept's double-quoted output round-trips correctly.
          const vVal = isScalar(vPair.value) ? String(vPair.value.value ?? '') : '';
          if (VALET_KNOWN_KEYS.has(vKey)) {
            rawValet[vKey] = vVal;
          } else {
            unknownValetKeys.push(vKey);
          }
        }
        break;
      }
    }
  }

  // Materialize valet sub-keys into meta
  if ('sensitivity' in rawValet) {
    const s = rawValet['sensitivity'];
    if (s === 'private' || s === 'shareable') meta.sensitivity = s;
  }
  if ('origin' in rawValet) meta.origin = rawValet['origin'];
  if ('expires' in rawValet) {
    const exp = rawValet['expires'];
    meta.expires = exp ? fromIso(exp) : null;
  }

  if (Object.keys(extras).length > 0) meta.extras = extras;

  return { body, meta, rawValet, unknownValetKeys, hadFrontmatter: true };
}

// ---------------------------------------------------------------------------
// Sentinel constants & fenced-block renderers
// ---------------------------------------------------------------------------

export const BACKLINKS_SENTINEL = '<!-- valet:backlinks — auto-generated; anything in this block is not part of the file and is stripped on write -->';
export const NOTICE_SENTINEL = '<!-- valet:notice — auto-generated; not part of the file -->';

/**
 * Render a backlinks fenced block for use in mem_read tool responses.
 * Structural shape (checked by sanitizeBody): sentinel + '# Linked from' heading + '- ' list lines.
 */
export function renderBacklinksBlock(
  links: Array<{ fromPath: string; title: string; context: string }>,
  journalCount: number,
  journalLatest: string,
  totalMore: number,
): string {
  const lines: string[] = [BACKLINKS_SENTINEL, '# Linked from'];
  for (const link of links.slice(0, 10)) {
    lines.push(`- [${link.title}](/${link.fromPath}) — ${link.context}`);
  }
  if (journalCount > 0) {
    lines.push(`- Referenced in ${journalCount} journal entries, latest ${journalLatest}`);
  }
  if (totalMore > 0) {
    lines.push(`- …and ${totalMore} more (use mem_links)`);
  }
  return lines.join('\n') + '\n';
}

/**
 * Render a notice fenced block for use in mem_read tool responses (e.g. expiry warnings).
 * Structural shape: sentinel + notice text line beginning with '⚠'.
 * Prefixes text with '⚠ ' when it doesn't already start with '⚠'.
 */
export function renderNoticeBlock(text: string): string {
  const prefixed = text.startsWith('⚠') ? text : `⚠ ${text}`;
  return `${NOTICE_SENTINEL}\n${prefixed}\n`;
}

// ---------------------------------------------------------------------------
// sanitizeBody
// ---------------------------------------------------------------------------

export interface SanitizeResult {
  body: string;
  embedded: ParsedConcept | null;  // parsed embedded frontmatter, if any
  warnings: string[];              // '⚠ …' strings for the tool response
}

/**
 * Strip a leading frontmatter block (captured as `embedded`) and any
 * structurally-matching sentinel-fenced blocks from agent-written content.
 *
 * Content after a stripped block is preserved; a warning is emitted when
 * non-whitespace content followed the removed region.
 * A sentinel appearing mid-line (not exactly the whole line) is untouched.
 */
export function sanitizeBody(input: string): SanitizeResult {
  const warnings: string[] = [];
  let text = input;
  let embedded: ParsedConcept | null = null;

  // Step 1: strip leading frontmatter
  if (text.startsWith('---\n')) {
    const parsed = parseConcept(text);
    if (parsed.hadFrontmatter) {
      embedded = parsed;
      text = parsed.body;
    }
  }

  // Step 2: scan for sentinel lines at exact line starts and strip matching blocks
  const sentinels = [BACKLINKS_SENTINEL, NOTICE_SENTINEL];
  const lines = text.split('\n');
  const resultLines: string[] = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];

    if (sentinels.includes(line)) {
      // Check structural match: next line must be '# Linked from' or start with '⚠'
      const nextIdx = i + 1;
      if (
        nextIdx < lines.length &&
        (lines[nextIdx] === '# Linked from' || lines[nextIdx].startsWith('⚠'))
      ) {
        // Consume heading/notice line
        let j = nextIdx + 1;
        // Consume '- ' list lines (zero or more)
        while (j < lines.length && lines[j].startsWith('- ')) {
          j++;
        }
        // j is now the first line after the block.
        // Find the next sentinel (if any) — content between here and the next sentinel
        // is genuine interstitial content; content between sentinels is not warned about.
        let nextSentinelIdx = j;
        while (nextSentinelIdx < lines.length && !sentinels.includes(lines[nextSentinelIdx])) {
          nextSentinelIdx++;
        }
        const interstitial = lines.slice(j, nextSentinelIdx);
        const hasContentAfter = interstitial.some(l => l.trim() !== '');
        if (hasContentAfter) {
          warnings.push(
            '⚠ content found after the auto-generated block was kept — it is now part of the file',
          );
          resultLines.push(...interstitial);
        }
        // Continue scanning from the next sentinel (or end of input).
        // If another sentinel is found there, the outer loop will strip it too.
        i = nextSentinelIdx;
        continue;
      }
    }

    resultLines.push(line);
    i++;
  }

  // Normalize trailing blank lines → single trailing newline
  let body = resultLines.join('\n');
  if (body.length > 0) {
    body = body.replace(/\n+$/, '\n');
  }

  return { body, embedded, warnings };
}

// ---------------------------------------------------------------------------
// applyDisposition
// ---------------------------------------------------------------------------

export interface DispositionInput {
  channel: 'agent' | 'trusted-import' | 'foreign-import';
  parsed: ParsedConcept;
  explicit: Partial<ConceptMeta>;    // tool params (agent) or nothing (import)
  existing: ConceptMeta | null;      // current row, null on create
}

export interface DispositionResult {
  meta: Partial<ConceptMeta>;        // fields to write (omissions = unchanged)
  warnings: string[];
  droppedValetKeys: string[];
}

/**
 * Apply the per-channel key-disposition policy with the stale-echo concurrency guard.
 *
 * Agent channel: OKF content keys merged only on a fresh echo (embedded timestamp
 * matches existing.updatedAt). Valet keys always ignored; warn if they differ from
 * stored. Explicit params always win.
 *
 * Trusted import: all OKF keys + valet keys honored.
 * Foreign import: OKF keys honored; sensitivity reset to 'private'; origin forced
 * to 'imported'; unknown valet.* dropped.
 *
 * source_session_id: never accepted from any channel (lands in droppedValetKeys
 * since parseConcept places it in unknownValetKeys).
 */
export function applyDisposition(input: DispositionInput): DispositionResult {
  const { channel, parsed, explicit, existing } = input;
  const meta: Partial<ConceptMeta> = {};
  const warnings: string[] = [];

  // Unknown valet sub-keys are always dropped and reported (all channels)
  const droppedValetKeys: string[] = [...parsed.unknownValetKeys];

  if (channel === 'agent') {
    // ── Stale-echo check ──────────────────────────────────────────────────
    let isFresh: boolean;
    if (existing === null) {
      // Create: merge unconditionally
      isFresh = true;
    } else if (parsed.meta.updatedAt !== undefined) {
      isFresh = parsed.meta.updatedAt === existing.updatedAt;
      if (!isFresh) {
        warnings.push(
          '⚠ file changed since it was read — embedded metadata ignored; pass metadata as params',
        );
      }
    } else {
      // No timestamp embedded — cannot confirm freshness; drop content keys silently
      isFresh = false;
    }

    // ── Merge OKF content keys when fresh ────────────────────────────────
    if (isFresh) {
      if (parsed.meta.type !== undefined) meta.type = parsed.meta.type;
      if (parsed.meta.description !== undefined) meta.description = parsed.meta.description;
      if (parsed.meta.resource !== undefined) meta.resource = parsed.meta.resource;
      if (parsed.meta.tags !== undefined) meta.tags = parsed.meta.tags;
    }

    // title: always ignored on agent channel

    // ── Valet keys: always ignored; warn when value differs from stored ──
    if (existing !== null) {
      for (const k of ['sensitivity', 'origin', 'expires'] as const) {
        if (k in parsed.rawValet) {
          const embeddedVal = parsed.meta[k];
          const storedVal = existing[k];
          if (embeddedVal !== storedVal) {
            warnings.push(`⚠ embedded valet.${k} ignored — pass ${k} as a param`);
          }
        }
      }
    }

  } else if (channel === 'trusted-import') {
    // Honor all OKF keys, title, timestamp, and valet keys
    if (parsed.meta.type !== undefined) meta.type = parsed.meta.type;
    if (parsed.meta.title !== undefined) meta.title = parsed.meta.title;
    if (parsed.meta.description !== undefined) meta.description = parsed.meta.description;
    if (parsed.meta.resource !== undefined) meta.resource = parsed.meta.resource;
    if (parsed.meta.tags !== undefined) meta.tags = parsed.meta.tags;
    if (parsed.meta.updatedAt !== undefined) meta.updatedAt = parsed.meta.updatedAt;
    if (parsed.meta.sensitivity !== undefined) meta.sensitivity = parsed.meta.sensitivity;
    if (parsed.meta.origin !== undefined) meta.origin = parsed.meta.origin;
    if (parsed.meta.expires !== undefined) meta.expires = parsed.meta.expires;

  } else {
    // foreign-import
    // Honor OKF keys and title
    if (parsed.meta.type !== undefined) meta.type = parsed.meta.type;
    if (parsed.meta.title !== undefined) meta.title = parsed.meta.title;
    if (parsed.meta.description !== undefined) meta.description = parsed.meta.description;
    if (parsed.meta.resource !== undefined) meta.resource = parsed.meta.resource;
    if (parsed.meta.tags !== undefined) meta.tags = parsed.meta.tags;
    if (parsed.meta.updatedAt !== undefined) meta.updatedAt = parsed.meta.updatedAt;
    // Sensitivity: always reset to 'private'
    meta.sensitivity = 'private';
    // Origin: always forced to 'imported'
    meta.origin = 'imported';
    // Expires: honored
    if (parsed.meta.expires !== undefined) meta.expires = parsed.meta.expires;
  }

  // Explicit params always win (applied last, unconditionally)
  Object.assign(meta, explicit);

  return { meta, warnings, droppedValetKeys };
}
