// INV-H2 (docs/specs/2026-10-16-presence-hub-design.md): Presence UI copy
// uses only the Terminology table's words. This lint parses every source
// file under components/presence, every routes/presence*.tsx, and each
// reused dialog the hub opens (HUB_DIALOGS), collects
// the text a reader can see (string literals, template text, JSX text), and
// fails on a banned word. Identifiers, imports, types, comments, and test
// files are not copy, so the lint skips them. A line that carries
// `// copy-lint: allow <word>` (on the line or the line before) may use that
// word; the spec Deviations list every allowance.
import { readdirSync, readFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";

const SRC = resolve(__dirname, "../..");
/** Dialogs outside components/presence that the hub opens. Their copy is
 * Presence copy too. */
const HUB_DIALOGS = [
  "components/workflows/trigger-dialog.tsx",
  "components/events/edit-subscription-dialog.tsx",
  "components/events/delivery-preferences.tsx",
  "components/events/event-match-step.tsx",
  "components/events/automation-review.tsx",
  "components/events/automation-wizard.tsx",
] as const;
const BANNED = ["subscription", "trigger", "subject", "event waiter", "automation"] as const;
const BANNED_RE = new RegExp(`\\b(${BANNED.join("|")})`, "gi");
const ALLOW_RE = /\/\/\s*copy-lint:\s*allow\s+([a-z ]+?)\s*$/i;

/** JSX attributes whose string values are never shown to a reader. */
const NON_COPY_ATTRIBUTES = new Set([
  "className", "key", "to", "href", "id", "htmlFor", "name", "type", "value",
  "role", "rel", "target", "mode", "variant", "size", "tone", "side", "align",
  "src", "method", "autoComplete", "inputMode", "pattern", "form", "idPrefix",
]);

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
      else if (/\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name)) files.push(path);
    }
  };
  walk(join(SRC, "components/presence"));
  for (const name of readdirSync(join(SRC, "routes"))) {
    if (/^presence.*\.tsx$/.test(name)) files.push(join(SRC, "routes", name));
  }
  for (const dialog of HUB_DIALOGS) files.push(join(SRC, dialog));
  return files.sort();
}

/** Object properties whose string values are code values, not copy. */
const CODE_PROPERTIES = new Set(["key", "mode", "kind", "type", "id", "tab", "status", "view", "outcome"]);

/** A string with no spaces that does not start with a capital is a code value
 * (an event key, a query key, a path, a discriminant), not copy. */
function looksLikeCodeValue(text: string): boolean {
  return !/\s/.test(text) && /[._:/*$-]/.test(text);
}

function isNonCopyPosition(node: ts.Node): boolean {
  const parent = node.parent;
  if (!parent) return false;
  if (ts.isImportDeclaration(parent) || ts.isExportDeclaration(parent)) return true;
  if (ts.isExternalModuleReference(parent)) return true;
  if (ts.isLiteralTypeNode(parent)) return true;
  if (ts.isCallExpression(parent) && parent.expression.kind === ts.SyntaxKind.ImportKeyword) return true;
  // An object key or a property name is an identifier in string form.
  if ((ts.isPropertyAssignment(parent) || ts.isPropertySignature(parent)) && parent.name === node) return true;
  if (ts.isPropertyAssignment(parent) && parent.initializer === node && CODE_PROPERTIES.has(parent.name.getText())) return true;
  // `"x" as const` pins a literal type: a code value.
  if (ts.isAsExpression(parent) && parent.type.getText() === "const") {
    const owner = parent.parent;
    if (owner && ts.isPropertyAssignment(owner) && CODE_PROPERTIES.has(owner.name.getText())) return true;
  }
  if (ts.isElementAccessExpression(parent) && parent.argumentExpression === node) return true;
  // A comparison or a case label compares code values.
  if (ts.isCaseClause(parent)) return true;
  if (ts.isBinaryExpression(parent)) {
    const op = parent.operatorToken.kind;
    if (
      op === ts.SyntaxKind.EqualsEqualsEqualsToken ||
      op === ts.SyntaxKind.ExclamationEqualsEqualsToken ||
      op === ts.SyntaxKind.EqualsEqualsToken ||
      op === ts.SyntaxKind.ExclamationEqualsToken ||
      op === ts.SyntaxKind.InKeyword
    ) return true;
  }
  if (ts.isJsxAttribute(parent)) {
    const name = parent.name.getText();
    if (NON_COPY_ATTRIBUTES.has(name) || name.startsWith("data-")) return true;
  }
  return false;
}

function lintCopy(file: string, source: string): CopyHit[] {
  const kind = file.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
  const sf = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, kind);
  const lines = source.split("\n");
  const hits: CopyHit[] = [];

  const allowed = (line: number, word: string): boolean => {
    for (const candidate of [lines[line], lines[line - 1]]) {
      const match = candidate ? ALLOW_RE.exec(candidate) : null;
      if (match && match[1].toLowerCase() === word.toLowerCase()) return true;
    }
    return false;
  };

  const check = (node: ts.Node, text: string) => {
    if (looksLikeCodeValue(text.trim())) return;
    if (isNonCopyPosition(node)) return;
    for (const match of text.matchAll(BANNED_RE)) {
      const word = match[1].toLowerCase();
      const offset = node.getStart(sf) + (node.getText(sf).indexOf(match[0]) >= 0 ? node.getText(sf).indexOf(match[0]) : 0);
      const line = sf.getLineAndCharacterOfPosition(offset).line;
      if (allowed(line, word)) continue;
      hits.push({ file: relative(SRC, file), line: line + 1, word, text: text.trim() });
    }
  };

  const visit = (node: ts.Node) => {
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) check(node, node.text);
    else if (ts.isTemplateHead(node) || ts.isTemplateMiddle(node) || ts.isTemplateTail(node)) {
      // A template's text parts count as copy only when the template is not
      // in a code position; check against the whole template expression.
      const template = node.parent && ts.isTemplateSpan(node.parent) ? node.parent.parent : node.parent;
      if (template && !isNonCopyPosition(template) && !/^[/~?]/.test(node.text)) {
        for (const match of node.text.matchAll(BANNED_RE)) {
          const word = match[1].toLowerCase();
          const line = sf.getLineAndCharacterOfPosition(node.getStart(sf)).line;
          if (allowed(line, word)) continue;
          hits.push({ file: relative(SRC, file), line: line + 1, word, text: node.text.trim() });
        }
      }
    } else if (ts.isJsxText(node)) check(node, node.text);
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return hits;
}

describe("Presence copy lint (INV-H2)", () => {
  it("finds a banned word in copy and skips code positions", () => {
    const hits = lintCopy(
      "sample.tsx",
      [
        'import { x } from "./subscription-match";',
        'type K = "trigger";',
        'const a = kind === "subscription" ? 1 : 2;',
        'const key = ["event-subscriptions"];',
        'const b = <p className="trigger">Edit the subscription</p>;',
        'const c = "Automation is off";',
        "// copy-lint: allow subject",
        'const d = "Pick a subject";',
        'const e = `${n} triggers fired`;',
        'const f = { mode: "subject" as const, label: `One thread per ${kind ?? "subject"}` };',
      ].join("\n"),
    );
    expect(hits.map((hit) => [hit.line, hit.word])).toEqual([
      [5, "subscription"],
      [6, "automation"],
      [9, "trigger"],
      [10, "subject"],
    ]);
  });

  it("finds no banned word in Presence UI copy", () => {
    const hits = sourceFiles().flatMap((file) => lintCopy(file, readFileSync(file, "utf8")));
    expect(hits.map((hit) => `${hit.file}:${hit.line} ${hit.word}: ${hit.text}`)).toEqual([]);
  });
});
