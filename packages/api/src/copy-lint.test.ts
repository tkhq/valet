// INV-H2 (docs/specs/2026-10-16-presence-hub-design.md) for the api side:
// the sentences the api sends to Presence use only the Terminology table's
// words. This lint parses the event and workflow services, the events,
// presence, and workflow-triggers routes, and the Slack inbox, whose stage
// texts admins read in Diagnostics. It reads each string literal,
// template, or `+` chain of them that holds a space, whatever its first
// letter: text a reader may see, such as an error, a reason, or a stage
// detail. It fails on a banned word. The banned words match the web lint
// (`packages/web/src/components/presence/copy-lint.test.ts`). A line that
// carries `// copy-lint: allow <word>` (on the line or the line before) may
// use that word, for the few texts that name a system value such as a tool
// id or a stored text. Comments, identifiers, test files, log lines
// (`console.*` arguments and text that opens with a `[tag]`), tagged
// templates such as `sql` queries, and the files only the model reads
// (MODEL_FACING) are not copy. Each banned word is a stem, so it also
// catches its inflections (deliveries, subscribed, triggered).
import { readdirSync, readFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";

const SRC = resolve(__dirname);
const DIRS = ["events", "workflows"] as const;
const FILES = [
  "routes/events.ts", "routes/presence.ts", "routes/workflow-triggers.ts", "routes/workflows.ts", "channels/slack-inbox.ts",
  "services/line-activity.ts", "services/presence-places.ts", "services/event-log.ts",
] as const;
/** Files whose sentences only the model reads: tool descriptions, tool
 * results, and thread prompts. They name tool ids such as
 * `events.list_subscriptions`, so the system words stay. */
const MODEL_FACING = new Set([
  "events/actions.ts", "workflows/actions.ts", "workflows/editor-thread-context.ts",
  // Workflow template prompts, and the run notes a workflow's agent reads.
  "workflows/template-definitions.ts", "workflows/run-attention.ts", "workflows/run-follow-up.ts",
]);
/** Each banned word's stem. A stem matches every inflection: `deliver`
 * matches delivery, deliveries, and delivered; `subscri` matches subscribe,
 * subscribed, and subscriptions. */
const BANNED_STEMS = ["listener", "automation", "subscri", "trigger", "subject", "rule", "deliver", "receipt"] as const;
/** Banned phrases, matched as written. */
const BANNED_PHRASES = ["event waiter", "Runs in"] as const;
const BANNED_RE = new RegExp(`\\b((?:${BANNED_STEMS.join("|")})[a-z]*|${BANNED_PHRASES.join("|")})`, "gi");

/** The stem or phrase a banned word matches, so `allow delivery` also allows "deliveries". */
function bannedRoot(word: string): string {
  const lower = word.toLowerCase();
  return BANNED_STEMS.find((stem) => lower.startsWith(stem)) ?? lower;
}
const ALLOW_RE = /\/\/\s*copy-lint:\s*allow\s+([a-z ]+?)\s*$/i;

interface CopyHit {
  file: string;
  line: number;
  word: string;
  text: string;
}

function sourceFiles(): string[] {
  const files: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (/\.ts$/.test(entry.name) && !/\.test\.ts$/.test(entry.name)) files.push(path);
    }
  };
  for (const dir of DIRS) walk(join(SRC, dir));
  for (const file of FILES) files.push(join(SRC, file));
  return files.filter((file) => !MODEL_FACING.has(relative(SRC, file))).sort();
}

/** Text a reader may see: any text with a space in it. A text with no space
 * is a code value (an event key, a column, a path, a discriminant). A text
 * that opens with a `[tag]` is a log line. */
function isSentence(text: string): boolean {
  const trimmed = text.trim();
  return /\s/.test(trimmed) && !trimmed.startsWith("[");
}

/** Whether a node is an argument of a `console.*` call: a log line, not copy. */
function inConsoleCall(node: ts.Node): boolean {
  for (let current = node.parent; current !== undefined; current = current.parent) {
    if (ts.isCallExpression(current)) {
      const callee = current.expression;
      if (ts.isPropertyAccessExpression(callee) && ts.isIdentifier(callee.expression) && callee.expression.text === "console") return true;
    }
  }
  return false;
}

/** The text of a `+` chain of literals and templates, or null when a part is not text. */
function chainText(node: ts.Expression): string | null {
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return node.text;
  if (ts.isTemplateExpression(node)) return templateText(node);
  if (ts.isParenthesizedExpression(node)) return chainText(node.expression);
  if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.PlusToken) {
    const left = chainText(node.left);
    const right = chainText(node.right);
    return left === null || right === null ? null : left + right;
  }
  return null;
}

/** The text of a template with each substitution read as `X`. */
function templateText(node: ts.TemplateExpression): string {
  return node.head.text + node.templateSpans.map((span) => `X${span.literal.text}`).join("");
}

function lintApiCopy(file: string, source: string): CopyHit[] {
  const sf = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const lines = source.split("\n");
  const hits: CopyHit[] = [];

  const allowed = (line: number, word: string): boolean => {
    for (const candidate of [lines[line], lines[line - 1]]) {
      const match = candidate ? ALLOW_RE.exec(candidate) : null;
      if (match && bannedRoot(match[1]!) === bannedRoot(word)) return true;
    }
    return false;
  };

  const check = (node: ts.Node, text: string) => {
    if (!isSentence(text) || inConsoleCall(node)) return;
    const line = sf.getLineAndCharacterOfPosition(node.getStart(sf)).line;
    for (const match of text.matchAll(BANNED_RE)) {
      const word = match[1]!.toLowerCase();
      if (allowed(line, word)) continue;
      hits.push({ file: relative(SRC, file), line: line + 1, word, text: text.trim() });
    }
  };

  const visit = (node: ts.Node) => {
    // A tagged template (`sql\`…\``) is a query, not copy.
    if (ts.isTaggedTemplateExpression(node)) return;
    // A message split over a `+` chain reads as one text.
    if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.PlusToken) {
      const text = chainText(node);
      if (text !== null) { check(node, text); return; }
    }
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) check(node, node.text);
    else if (ts.isTemplateExpression(node)) check(node, templateText(node));
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return hits;
}

describe("api Presence copy lint (INV-H2)", () => {
  it("reads every text with a space, skips log lines, and honors the allow comment", () => {
    const hits = lintApiCopy(
      "sample.ts",
      [
        'const a = "subscription_id";',
        'const b = "The subscription is off.";',
        'const c = `Edit the trigger for ${name}.`;',
        "// copy-lint: allow rule",
        'const d = "Call create_rule to add it.";',
        'const e = "rule names must be unique";',
        'console.warn("delivery failed", err);',
        'const f = "[ingest] receipt write failed";',
        'const g = "This line covers " +',
        '  "every receipt.";',
        'const h = "Runs in a new thread.";',
        'const q = sql`SELECT 1 FROM event_deliveries WHERE subscription_id = ${id}`;',
        'const i = "No duplicate deliveries were created.";',
        'const j = "Subscribe to the channel, then retry.";',
        'const k = "It was delivered and triggered twice.";',
        "// copy-lint: allow delivery",
        'const l = "Two deliveries ran.";',
      ].join("\n"),
    );
    expect(hits.map((hit) => [hit.line, hit.word])).toEqual([
      [2, "subscription"],
      [3, "trigger"],
      [6, "rule"],
      [9, "receipt"],
      [11, "runs in"],
      [13, "deliveries"],
      [14, "subscribe"],
      [15, "delivered"],
      [15, "triggered"],
    ]);
  });

  it("reads the event and workflow services and both routes", () => {
    const read = new Set(sourceFiles().map((file) => relative(SRC, file)));
    for (const file of [
      "routes/events.ts", "routes/presence.ts", "routes/workflow-triggers.ts", "routes/workflows.ts", "events/dispatcher.ts", "workflows/service.ts",
      "services/line-activity.ts", "services/presence-places.ts", "services/event-log.ts",
    ]) {
      expect(read.has(file), file).toBe(true);
    }
    expect(read.has("events/actions.ts")).toBe(false);
  });

  it("finds no banned word in a sentence the api sends to Presence", () => {
    const hits = sourceFiles().flatMap((file) => lintApiCopy(file, readFileSync(file, "utf8")));
    expect(hits.map((hit) => `${hit.file}:${hit.line} ${hit.word}: ${hit.text}`)).toEqual([]);
  });
});
