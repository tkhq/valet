/**
 * Whether `path` matches one of the globs. `**` matches across directories,
 * `*` and `?` stay within one. A pattern without a slash matches at any
 * depth; a trailing slash matches everything under that directory.
 */
export function matchesGlob(path: string, patterns: readonly string[]): boolean {
  return patterns.some((raw) => {
    let p = raw.trim().replace(/^\.?\//, "");
    if (p.endsWith("/")) p += "**";
    if (!p.includes("/")) p = `**/${p}`;
    let re = "";
    for (let i = 0; i < p.length; i++) {
      const ch = p[i];
      if (ch === "*" && p[i + 1] === "*") {
        const slash = p[i + 2] === "/";
        re += slash ? "(?:.*/)?" : ".*";
        i += slash ? 2 : 1;
      } else if (ch === "*") re += "[^/]*";
      else if (ch === "?") re += "[^/]";
      else re += ch.replace(/[.+^${}()|[\]\\]/g, "\\$&");
    }
    return new RegExp(`^${re}$`).test(path);
  });
}
