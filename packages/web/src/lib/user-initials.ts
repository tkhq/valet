/**
 * Avatar initials for a user display label (a name or an email).
 *
 * Up to two initials from the label's words. An email contributes only its
 * local part — "bob@example.com" is "B", not "BE" (the domain is not the
 * person). First characters are taken per code point, not per UTF-16 code
 * unit, so emoji- or non-BMP-leading names render whole glyphs.
 *
 * This is the canonical initials helper; other surfaces (members table,
 * teams panel, connect dialog) still carry older single-character inline
 * versions — migrate them here rather than adding a fifth variant.
 */
export function userInitials(label: string): string {
  const at = label.indexOf("@");
  const base = at > 0 ? label.slice(0, at) : label;
  const words = base.split(/[\s._-]+/).filter(Boolean);
  const initials = words.slice(0, 2).map((w) => [...w].slice(0, 1).join("").toUpperCase());
  return initials.join("") || "?";
}
