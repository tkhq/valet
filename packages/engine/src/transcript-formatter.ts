/** Flatten untrusted transcript fields without losing visible multiline boundaries. */
export function formatTranscriptText(text: string): string {
  // Scan disjoint whitespace runs, then inspect each run once. A whitespace
  // prefix before a required break would retry at every space on a single line.
  return text.replace(/[\s\u0085]+/g, (run) =>
    /[\r\n\v\f\u0085\u2028\u2029]/.test(run) ? " \u23ce " : run,
  ).trim();
}
