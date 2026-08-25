/**
 * One human-readable byte-size formatter for every surface that names a
 * file size to a user: the agent's file-attachment note (engine), the CLI
 * upload result lines, and the web composer chips. One definition so the
 * same byte count never prints three different ways.
 *
 * Style: "512 bytes", "1.5 KB", "5 KB", "2.5 MB", "5 MB" — whole numbers
 * drop the decimal.
 *
 * (`packages/web/src/lib/format-bytes.ts` is a different, pre-existing
 * formatter with GB support and fixed decimals, used by other web UI.)
 */
export function formatBytes(bytes: number): string {
  if (bytes >= 1024 * 1024) {
    const mb = bytes / (1024 * 1024);
    return `${mb % 1 === 0 ? mb : mb.toFixed(1)} MB`;
  }
  if (bytes >= 1024) {
    const kb = bytes / 1024;
    return `${kb % 1 === 0 ? kb : kb.toFixed(1)} KB`;
  }
  return `${bytes} bytes`;
}
