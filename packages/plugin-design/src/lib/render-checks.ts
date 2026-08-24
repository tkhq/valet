/**
 * Static render diagnostics for the write boundary. The canvas sanitizer
 * strips scripts and event handlers at RENDER time (spec Decision 1) —
 * silently, from the writing agent's point of view. These checks run when
 * a document is WRITTEN and come back as notes in the tool result, so the
 * agent learns "this will not work in the canvas" in the same turn it
 * wrote it, instead of shipping a deck of blank slides and hearing about
 * it from the user. Notes only — the write always proceeds (alert, don't
 * repair).
 */

const STYLE_BLOCK_RE = /<style[^>]*>([\s\S]*?)<\/style>/gi;

/** True when a bare `section` selector rule hides sections by default —
 * the reveal-deck pattern (`section { position:absolute; opacity:0 }` +
 * a script that adds `.active`). */
export function hidesSectionsByDefault(html: string): boolean {
  let style: RegExpExecArray | null;
  STYLE_BLOCK_RE.lastIndex = 0;
  while ((style = STYLE_BLOCK_RE.exec(html)) !== null) {
    const css = style[1];
    const ruleRe = /(^|[}{;\s])section\s*\{([^}]*)\}/g;
    let rule: RegExpExecArray | null;
    while ((rule = ruleRe.exec(css)) !== null) {
      const body = rule[2];
      if (
        /opacity\s*:\s*0(?![.\d])/.test(body) ||
        /display\s*:\s*none/.test(body) ||
        /visibility\s*:\s*hidden/.test(body)
      ) {
        return true;
      }
    }
  }
  return false;
}

export function staticRenderChecks(html: string): string[] {
  const notes: string[] = [];

  const scripts = (html.match(/<script\b/gi) ?? []).length;
  if (scripts > 0) {
    notes.push(
      `the document contains ${scripts} <script> tag${scripts === 1 ? "" : "s"} — the canvas strips scripts before rendering, so they NEVER run. Remove them; the canvas provides slide navigation itself.`,
    );
  }

  const handlers = (html.match(/\son[a-z]+\s*=\s*["']/gi) ?? []).length;
  if (handlers > 0) {
    notes.push(
      `${handlers} inline event handler${handlers === 1 ? "" : "s"} (on*=) will be stripped by the canvas sanitizer and never fire.`,
    );
  }

  if (hidesSectionsByDefault(html)) {
    notes.push(
      "the stylesheet hides <section> elements by default (opacity:0 / display:none / visibility:hidden). With scripts stripped, nothing reveals them — every slide except a pre-marked one renders blank. Make every section statically visible; the canvas shows one slide at a time on its own.",
    );
  }

  return notes;
}
