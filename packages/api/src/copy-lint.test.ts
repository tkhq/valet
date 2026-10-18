// INV-H2 (docs/specs/2026-10-16-presence-hub-design.md) for the api side:
// the sentences the api sends to Presence use only the Terminology table's
// words. This lint parses the event and workflow services and the events,
// presence, and workflow-triggers routes. It reads each string literal or
// template that starts with a capital letter and ends with a period: a sentence a reader sees,
// such as an error or a reason. It fails on a banned word. A line that
// carries `// copy-lint: allow <word>` (on the line or the line before) may
// use that word, for the few sentences that name a system value such as a
// tool id. Comments, identifiers, and test files are not copy, and neither
// are the files only the model reads (MODEL_FACING).
import { readdirSync, readFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";

const SRC = resolve(__dirname);
const DIRS = ["events", "workflows"] as const;
const FILES = ["routes/events.ts", "routes/presence.ts", "routes/workflow-triggers.ts"] as const;
/** Files whose sentences only the model reads: tool descriptions, tool
 * results, and thread prompts. They name tool ids such as
 * `events.list_subscriptions`, so the system words stay. */
const MODEL_FACING = new Set(["events/actions.ts", "workflows/actions.ts", "workflows/editor-thread-context.ts"]);
const BANNED = ["listener", "automation", "subscription", "trigger", "subject", "rule", "event waiter"] as const;
const BANNED_RE = new RegExp(`\\b(${BANNED.join("|")})`, "gi");
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

/** A sentence a reader sees: it starts with a capital letter and ends with a period. */
function isSentence(text: string): boolean {
  const trimmed = text.trim();
  return /^[A-Z]/.test(trimmed) && /\.$/.test(trimmed);
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
      if (match && match[1]!.toLowerCase() === word.toLowerCase()) return true;
    }
    return false;
  };

  const check = (node: ts.Node, text: string) => {
    if (!isSentence(text)) return;
    const line = sf.getLineAndCharacterOfPosition(node.getStart(sf)).line;
    for (const match of text.matchAll(BANNED_RE)) {
      const word = match[1]!.toLowerCase();
      if (allowed(line, word)) continue;
      hits.push({ file: relative(SRC, file), line: line + 1, word, text: text.trim() });
    }
  };

  const visit = (node: ts.Node) => {
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) check(node, node.text);
    else if (ts.isTemplateExpression(node)) check(node, templateText(node));
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return hits;
}

describe("api Presence copy lint (INV-H2)", () => {
  it("reads only sentences, and honors the allow comment", () => {
    const hits = lintApiCopy(
      "sample.ts",
      [
        'const a = "subscription_id";',
        'const b = "The subscription is off.";',
        'const c = `Edit the trigger for ${name}.`;',
        "// copy-lint: allow rule",
        'const d = "Call create_rule to add it.";',
        'const e = "Rule names must be unique";',
      ].join("\n"),
    );
    expect(hits.map((hit) => [hit.line, hit.word])).toEqual([
      [2, "subscription"],
      [3, "trigger"],
    ]);
  });

  it("reads the event and workflow services and both routes", () => {
    const read = new Set(sourceFiles().map((file) => relative(SRC, file)));
    for (const file of ["routes/events.ts", "routes/presence.ts", "routes/workflow-triggers.ts", "events/dispatcher.ts", "workflows/service.ts"]) {
      expect(read.has(file), file).toBe(true);
    }
    expect(read.has("events/actions.ts")).toBe(false);
  });

  it("finds no banned word in a sentence the api sends to Presence", () => {
    const hits = sourceFiles().flatMap((file) => lintApiCopy(file, readFileSync(file, "utf8")));
    expect(hits.map((hit) => `${hit.file}:${hit.line} ${hit.word}: ${hit.text}`)).toEqual([]);
  });
});
