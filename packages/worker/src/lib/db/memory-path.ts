/**
 * Memory path normalization. Kept in a dependency-free leaf module so that both
 * `memory-files.ts` and `memory-okf-helpers.ts` can import it without forming an
 * import cycle (previously memory-okf-helpers imported this from memory-files,
 * which imports memory-okf-helpers back).
 */
export function normalizePath(raw: string): string {
  // Strip leading slashes
  let p = raw.replace(/^\/+/, '');
  // Lowercase
  p = p.toLowerCase();
  // Kebab-case: replace spaces and underscores with hyphens
  p = p.replace(/[\s_]+/g, '-');
  // Remove invalid characters (keep alphanumeric, hyphens, dots, slashes)
  p = p.replace(/[^a-z0-9\-./]/g, '');
  // Split into segments, remove traversal (.. and .), rejoin
  const segments = p.split('/').filter((s) => s !== '..' && s !== '.' && s !== '');
  p = segments.join('/');
  return p;
}
