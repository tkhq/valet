/**
 * Workflow DAG expression and template language.
 *
 * AST-based parser + evaluator for the dag/v1 expression language.
 *
 * Supports:
 *   - Path reads against { trigger, nodes } (and aliases set by
 *     foreach iteration bodies).
 *   - Literals: string, number, boolean, null.
 *   - Comparisons: ==, !=, <, <=, >, >=.
 *   - Boolean operators: &&, ||, !.
 *   - Membership: `in`.
 *   - Existence: exists(path).
 *
 * Does NOT support: arithmetic, function calls beyond `exists`, regex,
 * `eval`, `Function`, or any general-purpose JavaScript.
 *
 * Templates: `{{path.to.value}}` interpolation. Single-template fields
 * preserve structured values; mixed-text templates stringify per spec
 * §"Undefined and error behavior".
 */

// ─── Public types ───────────────────────────────────────────────────────────

/**
 * Sink for paths that do not resolve, attached to a context under
 * {@link TEMPLATE_MISS_RECORDER}.
 *
 * A miss is invisible by design in this language: `{{nodes.x.result.text}}`
 * renders as null or "" and the run reports success with wrong output. The
 * recorder is how the interpreter sees those misses without every executor
 * reporting them itself. It is passive — recording never changes what a
 * template renders to.
 *
 * `ctx` is the context the miss happened in, which is NOT always the
 * context the recorder was attached to: a `foreach` body renders against
 * the same context plus its `item`/`index` aliases. Diagnostics must read
 * the keys in scope AT THE MISS, so the reader is passed the real one.
 */
export interface TemplateMissRecorder {
  record(segments: string[], ctx: TemplateContext): void;
}

/**
 * Key for the optional {@link TemplateMissRecorder} on a context.
 *
 * A symbol, for two reasons. Path resolution walks string segments, so no
 * template can read or shadow it. Object spread copies own enumerable
 * symbol keys, so it survives `resolveTemplateContext`'s alias merge and
 * reaches a `foreach` body without the body executor knowing about it.
 */
export const TEMPLATE_MISS_RECORDER: unique symbol = Symbol('valet.workflow.templateMissRecorder');

export interface TemplateContext {
  trigger?: unknown;
  nodes?: unknown;
  /** Set by the interpreter; see {@link TEMPLATE_MISS_RECORDER}. */
  [TEMPLATE_MISS_RECORDER]?: TemplateMissRecorder;
  /** Aliases set by foreach iteration bodies (e.g. `item`, `index`). */
  [alias: string]: unknown;
}

/** A context that reports its unresolved paths to `recorder`. */
export function withMissRecorder(ctx: TemplateContext, recorder: TemplateMissRecorder): TemplateContext {
  return { ...ctx, [TEMPLATE_MISS_RECORDER]: recorder };
}

export class TemplateParseError extends Error {
  constructor(message: string, public readonly source: string) {
    super(`template_parse_error: ${message} (in: ${truncate(source, 80)})`);
    this.name = 'TemplateParseError';
  }
}

export class TemplateEvalError extends Error {
  constructor(message: string, public readonly source: string) {
    super(`template_eval_error: ${message} (in: ${truncate(source, 80)})`);
    this.name = 'TemplateEvalError';
  }
}

// ─── Expression AST ─────────────────────────────────────────────────────────

type ExprNode =
  | { kind: 'literal'; value: string | number | boolean | null }
  | { kind: 'path'; segments: string[] }
  | { kind: 'unary'; op: '!'; operand: ExprNode }
  | { kind: 'binary'; op: ComparisonOp | LogicalOp | 'in'; left: ExprNode; right: ExprNode }
  | { kind: 'exists'; segments: string[] };

type ComparisonOp = '==' | '!=' | '<' | '<=' | '>' | '>=';
type LogicalOp = '&&' | '||';

// ─── Expression parser (recursive descent) ──────────────────────────────────

interface ParserState {
  source: string;
  pos: number;
}

function peek(s: ParserState): string {
  return s.source[s.pos] ?? '';
}

function skipWs(s: ParserState): void {
  while (s.pos < s.source.length && /\s/.test(s.source[s.pos]!)) s.pos++;
}

function consume(s: ParserState, lit: string): boolean {
  skipWs(s);
  if (s.source.startsWith(lit, s.pos)) {
    s.pos += lit.length;
    return true;
  }
  return false;
}

function expect(s: ParserState, lit: string): void {
  if (!consume(s, lit)) {
    throw new TemplateParseError(`expected ${JSON.stringify(lit)} at position ${s.pos}`, s.source);
  }
}

/** Parses a full expression and ensures the whole source is consumed. */
export function parseExpression(source: string): ExprNode {
  const s: ParserState = { source, pos: 0 };
  const ast = parseOr(s);
  skipWs(s);
  if (s.pos < source.length) {
    throw new TemplateParseError(`unexpected trailing content at position ${s.pos}`, source);
  }
  return ast;
}

function parseOr(s: ParserState): ExprNode {
  let left = parseAnd(s);
  while (consume(s, '||')) {
    const right = parseAnd(s);
    left = { kind: 'binary', op: '||', left, right };
  }
  return left;
}

function parseAnd(s: ParserState): ExprNode {
  let left = parseNot(s);
  while (consume(s, '&&')) {
    const right = parseNot(s);
    left = { kind: 'binary', op: '&&', left, right };
  }
  return left;
}

function parseNot(s: ParserState): ExprNode {
  skipWs(s);
  if (consume(s, '!')) {
    // Distinguish from `!=`. `!=` is a comparison parsed in parseComparison.
    if (peek(s) === '=') {
      // Restore the consumed `!` so parseComparison sees it.
      s.pos -= 1;
      return parseComparison(s);
    }
    const operand = parseNot(s);
    return { kind: 'unary', op: '!', operand };
  }
  return parseComparison(s);
}

const COMPARISON_OPS: ComparisonOp[] = ['==', '!=', '<=', '>=', '<', '>'];

function parseComparison(s: ParserState): ExprNode {
  const left = parseInExpr(s);
  skipWs(s);
  for (const op of COMPARISON_OPS) {
    if (consume(s, op)) {
      const right = parseInExpr(s);
      return { kind: 'binary', op, left, right };
    }
  }
  return left;
}

function parseInExpr(s: ParserState): ExprNode {
  const left = parsePrimary(s);
  skipWs(s);
  // `in` must be followed by a delimiter (whitespace or paren).
  if (s.source.startsWith('in', s.pos) && /[\s({[]/.test(s.source[s.pos + 2] ?? '')) {
    s.pos += 2;
    const right = parsePrimary(s);
    return { kind: 'binary', op: 'in', left, right };
  }
  return left;
}

function parsePrimary(s: ParserState): ExprNode {
  skipWs(s);

  if (consume(s, '(')) {
    const inner = parseOr(s);
    expect(s, ')');
    return inner;
  }

  if (consume(s, 'exists(')) {
    const segments = parsePathSegments(s);
    expect(s, ')');
    return { kind: 'exists', segments };
  }

  // Literals
  const ch = peek(s);
  if (ch === '"' || ch === "'") {
    return { kind: 'literal', value: parseStringLiteral(s) };
  }
  if (ch === '-' || (ch >= '0' && ch <= '9')) {
    return { kind: 'literal', value: parseNumberLiteral(s) };
  }

  // Keywords / identifiers
  const ident = readIdentifier(s);
  if (ident === 'true') return { kind: 'literal', value: true };
  if (ident === 'false') return { kind: 'literal', value: false };
  if (ident === 'null') return { kind: 'literal', value: null };
  if (ident === '') {
    throw new TemplateParseError(`unexpected character ${JSON.stringify(ch)} at position ${s.pos}`, s.source);
  }
  // Path expression — read remaining dotted segments.
  const segments = [ident, ...readDottedTail(s)];
  return { kind: 'path', segments };
}

function parseStringLiteral(s: ParserState): string {
  const quote = s.source[s.pos];
  if (quote !== '"' && quote !== "'") {
    throw new TemplateParseError(`expected string literal at position ${s.pos}`, s.source);
  }
  s.pos++;
  let out = '';
  while (s.pos < s.source.length) {
    const c = s.source[s.pos]!;
    if (c === '\\') {
      const next = s.source[s.pos + 1];
      if (next === undefined) {
        throw new TemplateParseError(`unterminated escape sequence`, s.source);
      }
      out += next === 'n' ? '\n' : next === 't' ? '\t' : next;
      s.pos += 2;
      continue;
    }
    if (c === quote) {
      s.pos++;
      return out;
    }
    out += c;
    s.pos++;
  }
  throw new TemplateParseError(`unterminated string literal`, s.source);
}

function parseNumberLiteral(s: ParserState): number {
  const start = s.pos;
  if (s.source[s.pos] === '-') s.pos++;
  const digitsStart = s.pos;
  while (s.pos < s.source.length && /[0-9.]/.test(s.source[s.pos]!)) s.pos++;
  // Require at least one digit. Without this guard, an empty bracket
  // subscript `nodes.x[]` would silently parse as `nodes.x[0]` because
  // Number('') === 0.
  if (s.pos === digitsStart) {
    throw new TemplateParseError(`expected number literal at position ${start}`, s.source);
  }
  const text = s.source.slice(start, s.pos);
  const n = Number(text);
  if (Number.isNaN(n)) {
    throw new TemplateParseError(`invalid number literal ${JSON.stringify(text)}`, s.source);
  }
  return n;
}

function readIdentifier(s: ParserState): string {
  skipWs(s);
  const start = s.pos;
  while (s.pos < s.source.length && /[A-Za-z0-9_]/.test(s.source[s.pos]!)) s.pos++;
  return s.source.slice(start, s.pos);
}

function readDottedTail(s: ParserState): string[] {
  const out: string[] = [];
  while (s.source[s.pos] === '.') {
    s.pos++;
    const seg = readIdentifier(s);
    if (seg === '') {
      throw new TemplateParseError(`empty path segment after '.' at position ${s.pos}`, s.source);
    }
    out.push(seg);
  }
  // Bracket subscript support: nodes.x[0].y, nodes.x["weird-key"], nodes.x[name].
  while (s.source[s.pos] === '[') {
    s.pos++;
    const ch = s.source[s.pos];
    let idx: string;
    if (ch === '"' || ch === "'") {
      idx = parseStringLiteral(s);
    } else if (ch === '-' || (ch !== undefined && ch >= '0' && ch <= '9')) {
      idx = parseNumberLiteral(s).toString();
    } else {
      const ident = readIdentifier(s);
      if (ident === '') {
        throw new TemplateParseError(`empty bracket subscript at position ${s.pos}`, s.source);
      }
      idx = ident;
    }
    out.push(idx);
    expect(s, ']');
    while (s.source[s.pos] === '.') {
      s.pos++;
      const seg = readIdentifier(s);
      if (seg === '') {
        throw new TemplateParseError(`empty path segment after '.'`, s.source);
      }
      out.push(seg);
    }
  }
  return out;
}

function parsePathSegments(s: ParserState): string[] {
  const head = readIdentifier(s);
  if (head === '') {
    throw new TemplateParseError(`expected path identifier`, s.source);
  }
  return [head, ...readDottedTail(s)];
}

// ─── Expression evaluation ──────────────────────────────────────────────────

export function evaluateExpression(ast: ExprNode, ctx: TemplateContext): unknown {
  switch (ast.kind) {
    case 'literal':
      return ast.value;
    case 'path':
      return readPath(ctx, ast.segments);
    case 'exists':
      return readPathExists(ctx, ast.segments);
    case 'unary':
      return !truthy(evaluateExpression(ast.operand, ctx));
    case 'binary': {
      // Short-circuit boolean ops.
      if (ast.op === '&&') {
        const l = evaluateExpression(ast.left, ctx);
        if (!truthy(l)) return l;
        return evaluateExpression(ast.right, ctx);
      }
      if (ast.op === '||') {
        const l = evaluateExpression(ast.left, ctx);
        if (truthy(l)) return l;
        return evaluateExpression(ast.right, ctx);
      }
      const l = evaluateExpression(ast.left, ctx);
      const r = evaluateExpression(ast.right, ctx);
      switch (ast.op) {
        case '==': return strictEqual(l, r);
        case '!=': return !strictEqual(l, r);
        case '<':  return compare(l, r) < 0;
        case '<=': return compare(l, r) <= 0;
        case '>':  return compare(l, r) > 0;
        case '>=': return compare(l, r) >= 0;
        case 'in': return inMembership(l, r);
      }
    }
  }
}

function truthy(v: unknown): boolean {
  if (v === null || v === undefined || v === false || v === 0 || v === '') return false;
  return true;
}

function strictEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  // null-loose: treat null and undefined as equivalent for missing data.
  if ((a === null || a === undefined) && (b === null || b === undefined)) return true;
  return false;
}

function compare(a: unknown, b: unknown): number {
  if (typeof a === 'number' && typeof b === 'number') return a - b;
  if (typeof a === 'string' && typeof b === 'string') {
    return a < b ? -1 : a > b ? 1 : 0;
  }
  // Date-like ISO strings compare lexicographically and that matches
  // chronological order for `YYYY-MM-DD...` format.
  throw new TemplateEvalError(`cannot compare values of mixed types`, JSON.stringify({ a, b }));
}

function inMembership(needle: unknown, haystack: unknown): boolean {
  if (Array.isArray(haystack)) return haystack.some((v) => strictEqual(v, needle));
  if (typeof haystack === 'string' && typeof needle === 'string') return haystack.includes(needle);
  if (haystack && typeof haystack === 'object' && typeof needle === 'string') {
    return Object.prototype.hasOwnProperty.call(haystack, needle);
  }
  return false;
}

// ─── Path resolution ────────────────────────────────────────────────────────

/**
 * Why a path did not resolve, and where. `container` is the object the
 * failed segment was looked up in — the source of "what keys WERE
 * available at that point" — and is absent only when the walk ran into a
 * non-object.
 *
 *   - `missing_key`   — the container has no such key.
 *   - `not_an_object` — the value before this segment cannot be indexed
 *                       (a string, a number, null).
 *   - `no_value`      — the key exists and holds `undefined`.
 */
export type PathResolution =
  | { ok: true; value: unknown }
  | {
      ok: false;
      failedIndex: number;
      reason: 'missing_key' | 'not_an_object' | 'no_value';
      container?: Record<string, unknown>;
    };

/**
 * Walk `segments` and report exactly where the walk stopped.
 *
 * {@link readPath} is this function with the detail thrown away, so the two
 * can never disagree about what "resolves" means.
 */
export function resolvePath(ctx: TemplateContext, segments: string[]): PathResolution {
  let cur: unknown = ctx;
  let container: Record<string, unknown> | undefined;
  for (let i = 0; i < segments.length; i++) {
    const seg = segments[i]!;
    if (cur === null || cur === undefined || typeof cur !== 'object') {
      return { ok: false, failedIndex: i, reason: 'not_an_object' };
    }
    container = cur as Record<string, unknown>;
    // `in`, not a truth test: a key holding `null` or `false` resolved
    // correctly, and reporting it as missing would send the author hunting
    // for a typo that is not there.
    if (!(seg in container)) {
      return { ok: false, failedIndex: i, reason: 'missing_key', container };
    }
    cur = container[seg];
  }
  if (cur === undefined) {
    // An empty `segments` cannot reach here — the context itself is an
    // object — so `failedIndex` always names a real segment.
    return { ok: false, failedIndex: segments.length - 1, reason: 'no_value', container };
  }
  return { ok: true, value: cur };
}

/**
 * The value at `segments`, or `undefined` when the path does not resolve.
 *
 * Reports every miss to the context's {@link TemplateMissRecorder} when one
 * is attached. The returned value is the same either way: recording a miss
 * must never change what a workflow renders.
 */
function readPath(ctx: TemplateContext, segments: string[]): unknown {
  const resolved = resolvePath(ctx, segments);
  if (resolved.ok) return resolved.value;
  ctx[TEMPLATE_MISS_RECORDER]?.record(segments, ctx);
  return undefined;
}

function readPathExists(ctx: TemplateContext, segments: string[]): boolean {
  let cur: unknown = ctx;
  for (const seg of segments) {
    if (cur === null || cur === undefined) return false;
    if (typeof cur !== 'object') return false;
    if (!Object.prototype.hasOwnProperty.call(cur, seg)) return false;
    cur = (cur as Record<string, unknown>)[seg];
  }
  return cur !== undefined;
}

// ─── Template parsing + rendering ───────────────────────────────────────────

interface TemplateSegment {
  kind: 'literal' | 'expr';
  text: string;
  /** Parsed AST when kind === 'expr'. */
  ast?: ExprNode;
}

interface TemplateAst {
  segments: TemplateSegment[];
  /** True when the entire input is exactly one `{{...}}` with no surrounding text. */
  isSingle: boolean;
}

/** Parse a template string. Returns its segments + isSingle marker. */
export function parseTemplate(source: string): TemplateAst {
  const segments: TemplateSegment[] = [];
  let i = 0;
  let literal = '';
  while (i < source.length) {
    if (source.startsWith('{{', i)) {
      if (literal !== '') {
        segments.push({ kind: 'literal', text: literal });
        literal = '';
      }
      const end = findExpressionEnd(source, i + 2);
      if (end === -1) {
        throw new TemplateParseError(`unterminated {{ ... }} expression`, source);
      }
      const exprSrc = source.slice(i + 2, end).trim();
      const ast = parseExpression(exprSrc);
      segments.push({ kind: 'expr', text: exprSrc, ast });
      i = end + 2;
      continue;
    }
    literal += source[i];
    i++;
  }
  if (literal !== '') segments.push({ kind: 'literal', text: literal });

  // A template counts as "single" when, ignoring leading/trailing whitespace
  // outside the expression, the only thing in the source is one {{...}}.
  // This lets `  {{x}}  ` preserve structured values.
  const trimmed = source.trim();
  const isSingle =
    segments.filter((s) => s.kind === 'expr').length === 1 &&
    trimmed.startsWith('{{') && trimmed.endsWith('}}') &&
    !segments.some((s) => s.kind === 'literal' && s.text.trim() !== '');

  return { segments, isSingle };
}

/**
 * Scan for the closing `}}` of a template expression, respecting string
 * literals so a sequence like `{{"a }} b"}}` resolves to the correct end.
 * Returns the index of the opening `}` in the closing pair, or -1 if not
 * found.
 */
function findExpressionEnd(source: string, start: number): number {
  let i = start;
  while (i < source.length) {
    const c = source[i]!;
    if (c === '"' || c === "'") {
      // Skip over the string literal (including escapes).
      const quote = c;
      i++;
      while (i < source.length) {
        if (source[i] === '\\') { i += 2; continue; }
        if (source[i] === quote) { i++; break; }
        i++;
      }
      continue;
    }
    if (c === '}' && source[i + 1] === '}') return i;
    i++;
  }
  return -1;
}

// ─── Static path collection (validator support) ─────────────────────────────

function collectAstPaths(node: ExprNode, out: string[][]): void {
  switch (node.kind) {
    case 'path':
    case 'exists':
      out.push(node.segments);
      return;
    case 'unary':
      collectAstPaths(node.operand, out);
      return;
    case 'binary':
      collectAstPaths(node.left, out);
      collectAstPaths(node.right, out);
      return;
    case 'literal':
      return;
  }
}

/**
 * Parse `source` as a bare expression and return every data path it
 * dereferences (each as its segment array, e.g. `nodes.gate.result` →
 * `["nodes","gate","result"]`). Throws `TemplateParseError` on syntax
 * errors — callers that lint should try/catch and report. Used by the
 * definition validator to check node references statically.
 */
export function collectExpressionPaths(source: string): string[][] {
  const out: string[][] = [];
  collectAstPaths(parseExpression(source), out);
  return out;
}

/** Template counterpart of {@link collectExpressionPaths} — paths from
 * every `{{ ... }}` segment in the template. */
export function collectTemplatePaths(source: string): string[][] {
  const out: string[][] = [];
  for (const seg of parseTemplate(source).segments) {
    if (seg.kind === 'expr' && seg.ast) collectAstPaths(seg.ast, out);
  }
  return out;
}

/** Like {@link collectAstPaths}, but skips `exists(...)` — probing a
 * possibly-missing path is that function's purpose, not a mistake. */
function collectAstValuePaths(node: ExprNode, out: string[][]): void {
  switch (node.kind) {
    case 'path':
      out.push(node.segments);
      return;
    case 'unary':
      collectAstValuePaths(node.operand, out);
      return;
    case 'binary':
      collectAstValuePaths(node.left, out);
      collectAstValuePaths(node.right, out);
      return;
    case 'exists':
    case 'literal':
      return;
  }
}

/**
 * Dotted paths in `source`'s `{{ ... }}` expressions that evaluate to
 * `undefined` against `ctx`. Executors use this to name the template
 * variable behind a downstream failure ("param must be a string") instead
 * of leaving the author to guess. Returns [] for unparseable sources —
 * parse errors are the validator's job, not this diagnostic's.
 */
export function collectUnresolvedTemplatePaths(source: string, ctx: TemplateContext): string[] {
  return collectTemplateValuePaths(source)
    .filter((p) => !resolvePath(ctx, p).ok)
    .map((p) => p.join('.'));
}

/**
 * Every value path in `source`'s `{{ ... }}` expressions, as segment
 * arrays. `exists(...)` paths are excluded — probing a possibly-missing
 * path is that function's purpose, not a mistake.
 *
 * Returns [] for an unparseable source. A parse error is the validator's
 * job to report; a diagnostic that re-reports it would double the noise.
 */
export function collectTemplateValuePaths(source: string): string[][] {
  let segments: TemplateSegment[];
  try {
    segments = parseTemplate(source).segments;
  } catch {
    return [];
  }
  const paths: string[][] = [];
  for (const seg of segments) {
    if (seg.kind === 'expr' && seg.ast) collectAstValuePaths(seg.ast, paths);
  }
  return paths;
}

/** Bare-expression counterpart of {@link collectTemplateValuePaths} (an `if` condition's `left`, an edge's `when`). */
export function collectExpressionValuePaths(source: string): string[][] {
  const paths: string[][] = [];
  try {
    collectAstValuePaths(parseExpression(source), paths);
  } catch {
    return [];
  }
  return paths;
}

/**
 * Render a template against a context.
 *
 * Single-template fields (`isSingle`) preserve the underlying value's
 * type. Mixed-text templates concatenate everything to a string per the
 * spec rules. Undefined paths follow spec §"Undefined and error
 * behavior".
 */
export function renderTemplate(source: string, ctx: TemplateContext): unknown {
  const ast = parseTemplate(source);

  if (ast.isSingle) {
    // Find the single expression segment (there may be whitespace-only
    // literal segments around it; isSingle ignores those).
    const exprSeg = ast.segments.find((s) => s.kind === 'expr');
    const value = evaluateExpression(exprSeg!.ast!, ctx);
    // Single-template undefined → null per spec.
    return value === undefined ? null : value;
  }

  // Mixed text: concatenate.
  let out = '';
  for (const seg of ast.segments) {
    if (seg.kind === 'literal') {
      out += seg.text;
      continue;
    }
    const v = evaluateExpression(seg.ast!, ctx);
    out += stringifyForMixedText(v);
  }
  return out;
}

function stringifyForMixedText(v: unknown): string {
  if (v === undefined || v === null) return '';
  if (typeof v === 'string') return v;
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  return JSON.stringify(v);
}

/**
 * Recursively render any string fields in a JSON value as templates.
 * Used by node executors to render their params / prompts / etc. Object
 * keys are NOT rendered; only values. Arrays are walked.
 */
export function renderJsonTemplates<T>(value: T, ctx: TemplateContext): T {
  if (typeof value === 'string') {
    return renderTemplate(value, ctx) as T;
  }
  if (Array.isArray(value)) {
    return value.map((v) => renderJsonTemplates(v, ctx)) as unknown as T;
  }
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = renderJsonTemplates(v, ctx);
    }
    return out as T;
  }
  return value;
}

// ─── Helpers ────────────────────────────────────────────────────────────────

function truncate(s: string, n: number): string {
  return s.length <= n ? s : s.slice(0, n) + '...';
}
