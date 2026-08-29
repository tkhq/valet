/**
 * Path-glob matching for cell scope adherence (§reportFinding scope check).
 *
 * A plan cell scopes to part of the repo with include globs on `paths`
 * (`packages/api/**`, `packages/payments/**`). The security service checks that
 * a reported finding's `file` sits inside one of the acting cell's globs. This
 * is the single glob matcher for that check — the same shape `changedDirGlobs`
 * produces (`<dir>/**`) and a repo-config plan declares.
 *
 * The grammar is deliberately small: `**` matches any run of characters
 * including `/`; `*` matches any run within one segment (no `/`); every other
 * character is literal. It covers the directory-prefix globs the plan uses; it
 * is NOT a full minimatch (no brace/`?`/char-class support), because the plan's
 * globs never need them.
 */

/** Translate one glob to an anchored regular expression. */
function globToRegExp(glob: string): RegExp {
  let out = "";
  for (let i = 0; i < glob.length; i++) {
    const ch = glob[i];
    if (ch === "*") {
      if (glob[i + 1] === "*") {
        // `**` — any characters, `/` included.
        out += ".*";
        i++;
      } else {
        // `*` — any characters except `/` (stays within one segment).
        out += "[^/]*";
      }
    } else if (/[.+?^${}()|[\]\\]/.test(ch)) {
      out += `\\${ch}`;
    } else {
      out += ch;
    }
  }
  return new RegExp(`^${out}$`);
}

/** Normalize a repo-relative path for matching: trim, drop a leading `./`. */
function normalizePath(path: string): string {
  const trimmed = path.trim();
  return trimmed.startsWith("./") ? trimmed.slice(2) : trimmed;
}

/**
 * True when `file` matches at least one of `globs`. An empty glob list means
 * the cell is unscoped (recon / verify / repo-wide) and every path matches, so
 * the caller must decide whether an empty list is "unscoped" before it calls.
 */
export function pathMatchesGlobs(file: string, globs: readonly string[]): boolean {
  const target = normalizePath(file);
  if (globs.length === 0) return true;
  for (const glob of globs) {
    const g = glob.trim();
    if (g === "") continue;
    if (globToRegExp(g).test(target)) return true;
  }
  return false;
}
