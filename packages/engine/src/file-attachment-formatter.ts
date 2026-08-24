/**
 * Formats file attachments as a system-authored note for agent annotation.
 *
 * Decision 7 from sandbox-file-upload design spec: when a user message
 * carries file attachments, the engine prepends a system-authored note
 * listing each file's path, size, and optional markdown sidecar.
 */

import type { MessageEntry } from "./types.js";

type FileAttachment = Extract<MessageEntry["attachments"], unknown[] | undefined>[number] & {
  type: "file";
};

/**
 * Format file attachments as a system-authored note per spec Decision 7.
 *
 * Example output:
 * ```
 * [User attached files to the sandbox:
 *   - /workspace/uploads/report.pdf (843 KB, PDF, markdown at /workspace/uploads/report.pdf.md)
 *   - /workspace/uploads/data.zip (extracted to /workspace/uploads/data/)
 * ]
 * ```
 *
 * Format rules (STE):
 * - One line per file. Path first, then the parenthetical.
 * - Size in the shortest sensible unit (B, KB, MB).
 * - For a PDF with a markdown sidecar, name the sidecar.
 * - For a zip that was extracted, name the extract root and end the path with `/`.
 *
 * @param files Array of file attachments to format.
 * @returns Formatted note string, or empty string if no files.
 */
export function formatFileAttachmentsNote(files: FileAttachment[]): string {
  if (!files || files.length === 0) {
    return "";
  }

  const lines = files.map((file) => {
    const sizeStr = formatBytes(file.bytes);
    const mimeType = file.mimeType || "unknown";

    // For PDFs with markdown sidecars, include sidecar path.
    if (mimeType === "application/pdf" && file.markdownPath) {
      return `  - ${file.path} (${sizeStr}, PDF, markdown at ${file.markdownPath})`;
    }

    // For archives that were extracted, indicate extraction root with trailing /.
    // Use markdownPath as a signal for extraction in this MVP.
    // The spec does not define extracted[] on the file variant,
    // so we rely on markdownPath presence. In future, when extraction
    // tracking lands, this can be refined to use an extracted: string[] field.
    if (
      (mimeType === "application/zip" || mimeType === "application/x-zip-compressed") &&
      file.markdownPath
    ) {
      // markdownPath holds extraction root for archives
      return `  - ${file.path} (extracted to ${file.markdownPath}/)`;
    }

    // Plain file: path, size, MIME type
    return `  - ${file.path} (${sizeStr}, ${mimeType})`;
  });

  return (
    "[User attached files to the sandbox:\n" +
    lines.join("\n") +
    "\n]"
  );
}

/**
 * Format bytes into human-readable size with shortest sensible unit.
 *
 * @param bytes Byte count
 * @returns Formatted string (e.g. "843 KB", "1.5 MB")
 */
function formatBytes(bytes: number): string {
  if (bytes < 1024) {
    return `${bytes} B`;
  }
  if (bytes < 1024 * 1024) {
    const kb = bytes / 1024;
    // Round to 1 decimal for readability, strip trailing .0
    return (kb % 1 === 0 ? kb : kb.toFixed(1)).toString().replace(/\.0$/, "") + " KB";
  }
  const mb = bytes / (1024 * 1024);
  return (mb % 1 === 0 ? mb : mb.toFixed(1)).toString().replace(/\.0$/, "") + " MB";
}
