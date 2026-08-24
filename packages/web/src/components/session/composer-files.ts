/**
 * File upload handling for the composer: upload to the API, hold attachment
 * refs, manage errors, and prepare the request body.
 *
 * Unlike images (which are read into data URLs and shipped inline), files
 * are uploaded to the sandbox via multipart POST and referenced by an
 * ephemeral `attachmentRef` that expires 15 minutes after upload.
 *
 * Intake helpers (size formatting, list/clipboard extraction, drag
 * detection) are shared with the image path — see `composer-images.ts`.
 *
 * Everything here is pure or DOM-agnostic, so it's testable without a browser.
 */

import { formatSize, readFailure } from "./composer-images";

export {
  filesFromClipboard,
  filesFromList,
  formatSize,
  readFailure,
  transferHasFiles,
  type ClipboardFileItem,
} from "./composer-images";

/** Master switch for file upload affordances in the composer. */
export const FILE_UPLOADS_ENABLED: boolean = true;

/**
 * One file being uploaded, uploaded, or errored. Upload state is derived:
 * no `attachmentRef` and no `error` means the upload is in flight (uploads
 * start the moment a file is accepted).
 */
export interface ComposerFile {
  /** Local unique id for React keys and removal. */
  id: string;
  name: string;
  bytes: number;
  /** The underlying File. Held so the upload hook can stream the bytes. */
  file: File;
  /** Set when upload completes successfully. */
  attachmentRef?: string;
  /** Set when upload fails. */
  error?: string;
}

/** Max files per message — matches the limit for images. */
export const MAX_FILES = 5;

/** Largest single file, in bytes (default 50 MB). */
export const MAX_FILE_BYTES = 50 * 1024 * 1024;

/** Largest total for all files, in bytes. */
export const MAX_TOTAL_BYTES = 250 * 1024 * 1024;

/** The file fields we need to check limits. */
export interface FileMeta {
  name: string;
  size: number;
}

/**
 * Split incoming files into accepted and rejected, applying the same
 * budgets as images: per-file max, total max, count max.
 */
export function acceptFiles<T extends FileMeta>(
  current: readonly ComposerFile[],
  incoming: readonly T[],
): { accepted: T[]; rejected: string[] } {
  const accepted: T[] = [];
  const rejected: string[] = [];
  let count = current.length;
  let total = current.reduce((sum, f) => sum + f.bytes, 0);

  for (const file of incoming) {
    if (file.size > MAX_FILE_BYTES) {
      rejected.push(
        `${file.name} is ${formatSize(file.size)}. The limit is ${formatSize(MAX_FILE_BYTES)} for one file. ` +
          `Reduce the file size, then attach it again.`,
      );
      continue;
    }
    if (count >= MAX_FILES) {
      rejected.push(
        `${file.name} was not attached. The limit is ${MAX_FILES} files for one message. ` +
          `Remove a file, then attach it again.`,
      );
      continue;
    }
    if (total + file.size > MAX_TOTAL_BYTES) {
      rejected.push(
        `${file.name} was not attached. The limit is ${formatSize(MAX_TOTAL_BYTES)} for all files ` +
          `on one message. Remove a file, then attach it again.`,
      );
      continue;
    }
    accepted.push(file);
    count += 1;
    total += file.size;
  }

  return { accepted, rejected };
}

/** Local id for a held file (same pattern as images). */
function newFileId(): string {
  return `file-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

/** Create a ComposerFile from a File object (before upload starts). */
export function createComposerFile(file: File): ComposerFile {
  return {
    id: newFileId(),
    name: file.name,
    bytes: file.size,
    file,
  };
}

/** True while this file's upload is still in flight. */
export function isFileUploading(file: ComposerFile): boolean {
  return file.attachmentRef === undefined && file.error === undefined;
}

/**
 * Payload builder for the send request — extract refs from files that have
 * completed upload successfully.
 */
export function toFileRefs(files: readonly ComposerFile[]): Array<{ ref: string }> {
  return files.flatMap((f) => (f.attachmentRef ? [{ ref: f.attachmentRef }] : []));
}
