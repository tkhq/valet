/**
 * Pure checks behind `scripts/check-conventions.ts` (the `conventions` row of
 * `make e2e`). Each check turns a recurring code-review rule from CLAUDE.md
 * into something executable, per the harness principle "promote recurring
 * review feedback into automation". No fs here — everything takes file
 * contents so it's unit-testable (`conventions.test.ts`).
 *
 * Spec: docs/specs/2026-07-25-e2e-runner-design.md
 */

export interface SourceFile {
  /** Repo-relative path (posix separators). */
  path: string;
  content: string;
}

export interface Violation {
  path: string;
  /** 1-indexed; 0 for file-level violations (package.json checks). */
  line: number;
  message: string;
}

/**
 * `as unknown as` ratchet: files allowed to keep their PRE-EXISTING
 * double-casts, with the exact count as of the baseline. New occurrences —
 * anywhere, including these files — fail the check. When you clean one up
 * (CLAUDE.md: "fix what you touch"), lower or delete its entry.
 */
export const DOUBLE_CAST_ALLOWLIST: Record<string, number> = {
  "packages/workflow/src/dag/expression.ts": 1,
  "packages/api/src/providers/blob-fs.ts": 1,
  "packages/api/src/prebuilds/service.ts": 1,
  "packages/api/src/engine/bridge.test.ts": 1,
  "packages/engine/test/model-switching.test.ts": 2,
  "packages/engine/test/list-threads-tool.test.ts": 2,
};

/** A real suppressor directive: the `@ts-…` immediately follows a comment
 * opener (`// @ts-ignore`, `/* @ts-expect-error`). Prose that merely mentions
 * the directive mid-comment ("never use @ts-ignore") doesn't match — and
 * wouldn't suppress anything for TypeScript either. */
const TS_SUPPRESS = /(?:^\s*\/\/|\/\*)\s*@ts-(ignore|expect-error)\b/;
const DOUBLE_CAST = /\bas unknown as\b/;

/** Lines that are (heuristically) comments — prose mentioning a banned
 * pattern shouldn't trip the double-cast check. */
function isCommentLine(line: string): boolean {
  const t = line.trimStart();
  return t.startsWith("//") || t.startsWith("*") || t.startsWith("/*");
}

/**
 * CLAUDE.md type-safety rules 2 & 4 as executable checks:
 * - `@ts-ignore` / `@ts-expect-error` are banned outright (baseline: zero).
 * - `as unknown as` double-casts are ratcheted via DOUBLE_CAST_ALLOWLIST.
 */
export function checkBannedPatterns(files: SourceFile[]): Violation[] {
  const violations: Violation[] = [];
  for (const file of files) {
    const lines = file.content.split("\n");
    let doubleCasts = 0;
    let firstCastLine = 0;
    for (let i = 0; i < lines.length; i++) {
      if (TS_SUPPRESS.test(lines[i])) {
        violations.push({
          path: file.path,
          line: i + 1,
          message:
            "@ts-ignore/@ts-expect-error is banned (CLAUDE.md type-safety rule 4) — fix the type error; for a third-party type bug use a minimal `as` with a comment linking the upstream issue",
        });
      }
      if (isCommentLine(lines[i])) continue;
      if (DOUBLE_CAST.test(lines[i])) {
        doubleCasts++;
        if (firstCastLine === 0) firstCastLine = i + 1;
      }
    }
    const allowed = DOUBLE_CAST_ALLOWLIST[file.path] ?? 0;
    if (doubleCasts > allowed) {
      violations.push({
        path: file.path,
        line: firstCastLine,
        message:
          `${doubleCasts} \`as unknown as\` double-cast(s), allowlist permits ${allowed} ` +
          "(CLAUDE.md type-safety rule 2) — the types disagree; fix the disagreement instead of silencing it. " +
          "In tests, provide the interface's required fields rather than double-casting a partial object.",
      });
    }
  }
  return violations;
}

export interface PackageManifest {
  /** Repo-relative path to the package.json. */
  path: string;
  json: {
    dependencies?: Record<string, string>;
    devDependencies?: Record<string, string>;
  };
}

/**
 * CLAUDE.md sandbox-gateway gotcha as an executable check: every package that
 * depends on `ws` must declare BOTH `@types/ws` AND `@types/node` itself —
 * otherwise pnpm's workspace layout can resolve `@types/node` from an
 * unrelated ancestor and silently pull in the wrong Node types. This shipped
 * twice (packages/api, then packages/sandbox-gateway) before becoming a rule.
 */
export function checkWsTypes(manifests: PackageManifest[]): Violation[] {
  const violations: Violation[] = [];
  for (const m of manifests) {
    const deps = { ...m.json.dependencies, ...m.json.devDependencies };
    if (!deps.ws) continue;
    for (const required of ["@types/ws", "@types/node"]) {
      if (!deps[required]) {
        violations.push({
          path: m.path,
          line: 0,
          message: `depends on \`ws\` but does not declare \`${required}\` (CLAUDE.md: every ws-consuming package must declare both @types/ws and @types/node) — add it to devDependencies`,
        });
      }
    }
  }
  return violations;
}

/** Human rendering: one line per violation + a summary line. */
export function renderViolations(violations: Violation[]): string {
  if (violations.length === 0) return "conventions: clean";
  const lines = violations.map((v) =>
    v.line > 0 ? `${v.path}:${v.line}  ${v.message}` : `${v.path}  ${v.message}`,
  );
  lines.push("");
  lines.push(`${violations.length} convention violation(s)`);
  return lines.join("\n");
}
