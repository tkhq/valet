import { createHash } from "node:crypto";

/**
 * Deterministic finding fingerprint: sha256 over the file path, the line
 * bucket (line ÷ 10, so small drifts collide on purpose), and the
 * normalized title; first 16 hex characters. The server computes it on
 * insert; distinct fingerprints keep near-duplicate reports from inflating
 * the manifest's headline counts.
 */
export function findingFingerprint(input: {
  file?: string | null;
  line?: number | null;
  title: string;
}): string {
  const file = input.file ?? "";
  const bucket = input.line == null ? "" : String(Math.floor(input.line / 10));
  const title = input.title.toLowerCase().replace(/\s+/g, " ").trim();
  return createHash("sha256").update(`${file}\n${bucket}\n${title}`).digest("hex").slice(0, 16);
}
