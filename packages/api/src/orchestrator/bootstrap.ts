/**
 * Journal helpers. Wake no longer creates a daily journal file, and
 * compaction no longer appends to one: both wrote files nothing read.
 * Journals written before that stay readable and searchable.
 */

/**
 * Whether a journal body holds an entry. Older builds created each day's
 * journal with only a `# <date>` heading, so that body alone, with blank
 * lines, has no entry. Any other line counts, a heading included: an
 * entry can be written as `## 14:30 Fixed the Slack reply bug`.
 */
export function journalHasEntries(content: string): boolean {
  const lines = content.split("\n").map((line) => line.trim()).filter((line) => line !== "");
  if (lines.length === 0) return false;
  return !(lines.length === 1 && /^#\s+\d{4}-\d{2}-\d{2}$/.test(lines[0]));
}
