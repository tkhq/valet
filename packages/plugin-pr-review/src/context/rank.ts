/**
 * Fit a unified diff to a character budget by relevance, not by position.
 * Noise (generated, lockfile, vendored, binary, minified, snapshot) goes
 * first. The rest is ranked risky paths first, then by size of change, and
 * whole files are kept in that order while they fit. Kept files stay in diff
 * order. Each file left out gets one line naming it and the reason, so the
 * reviewer knows it exists and can run `git diff` on it.
 */
import { looksGenerated, noiseKind, riskyPath, type NoiseKind } from "./paths.js";

export interface DroppedFile {
  path: string;
  reason: NoiseKind | "budget";
  added: number;
  removed: number;
  chars: number;
}

export interface RankedPatch {
  patch: string;
  truncated: boolean;
  dropped: DroppedFile[];
}

interface Chunk {
  index: number;
  path: string;
  text: string;
  added: number;
  removed: number;
  noise?: NoiseKind;
  risky: boolean;
}

export function rankPatch(full: string, budgetChars: number, riskPaths: readonly string[] = []): RankedPatch {
  if (full.length <= budgetChars) return { patch: full, truncated: false, dropped: [] };
  const chunks: Chunk[] = full
    .split(/^(?=diff --git )/m)
    .filter((t) => t.length > 0)
    .map((text, index) => {
      const path = /^diff --git a\/.* b\/(.*)$/m.exec(text)?.[1] ?? "";
      let added = 0;
      let removed = 0;
      const addedText: string[] = [];
      for (const line of text.split("\n")) {
        if (line.startsWith("+") && !line.startsWith("+++")) {
          added++;
          if (addedText.length < 12) addedText.push(line.slice(1));
        } else if (line.startsWith("-") && !line.startsWith("---")) removed++;
      }
      const noise = noiseKind(path) ?? (looksGenerated(addedText.join("\n")) ? "generated" : undefined);
      return { index, path, text, added, removed, ...(noise ? { noise } : {}), risky: riskyPath(path, riskPaths) };
    });
  // A diff header before the first file (rare) is kept as is.
  const preamble = chunks.length > 0 && !chunks[0].text.startsWith("diff --git ") ? chunks.shift() : undefined;

  const order = [...chunks].sort((a, b) => {
    if ((a.noise === undefined) !== (b.noise === undefined)) return a.noise === undefined ? -1 : 1;
    if (a.risky !== b.risky) return a.risky ? -1 : 1;
    return b.added + b.removed - (a.added + a.removed) || a.index - b.index;
  });
  // Reserve room for the note that names every left-out file.
  const noteRoom = Math.min(Math.floor(budgetChars / 10), chunks.length * 100 + 200);
  let used = preamble?.text.length ?? 0;
  const kept = new Set<number>();
  for (const c of order) {
    if (c.noise !== undefined) continue;
    if (used + c.text.length <= budgetChars - noteRoom) {
      kept.add(c.index);
      used += c.text.length;
    }
  }
  const dropped: DroppedFile[] = chunks
    .filter((c) => !kept.has(c.index))
    .map((c) => ({ path: c.path, reason: c.noise ?? "budget", added: c.added, removed: c.removed, chars: c.text.length }));
  if (dropped.length === 0) return { patch: full, truncated: false, dropped };
  const note = [
    "",
    "# Diff budget reached. These files are not shown, noise first; run `git diff` on any you need:",
    ...dropped.map((d) => `#   ${d.path} (+${d.added} -${d.removed}, ${d.reason})`),
    "",
  ].join("\n");
  const body = chunks.filter((c) => kept.has(c.index)).map((c) => c.text).join("");
  return { patch: (preamble?.text ?? "") + body + note, truncated: true, dropped };
}
