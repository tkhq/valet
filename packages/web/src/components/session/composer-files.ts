/**
 * File upload handling for the composer: upload to the API, hold attachment
 * refs, manage progress and errors, and prepare the request body.
 *
 * Unlike images (which are read into data URLs and shipped inline), files
 * are uploaded to the sandbox via multipart POST and referenced by an
 * ephemeral `attachmentRef` that expires 15 minutes after upload.
 *
 * Everything here is pure or DOM-agnostic, so it's testable without a browser.
 */

/** Master switch for file upload affordances in the composer. */
export const FILE_UPLOADS_ENABLED: boolean = true;

/**
 * One file being uploaded, uploaded, or errored.
 */
export interface ComposerFile {
  /** Local unique id for React keys and removal. */
  id: string;
  name: string;
  bytes: number;
  /** The upload progress: 0-100, or null if not yet started. */
  uploadProgress: number | null;
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

/** Human size for limits and labels. */
export function formatSize(bytes: number): string {
  if (bytes >= 1024 * 1024) {
    const mb = bytes / (1024 * 1024);
    return `${Number.isInteger(mb) ? mb : mb.toFixed(1)} MB`;
  }
  if (bytes >= 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${bytes} bytes`;
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

/** Message for a file that couldn't be read (e.g., permission). */
export function readFailure(name: string): string {
  return `${name} could not be read. Attach the file again.`;
}

/**
 * Files from a `FileList` (drop or picker). Nothing is filtered here on
 * purpose — `acceptFiles` judges every file, so a wrong file always earns a
 * message instead of vanishing.
 */
export function filesFromList(list: ArrayLike<File> | null | undefined): File[] {
  if (!list) return [];
  return Array.from(list);
}

/** The `DataTransferItem` fields we use for clipboard items. */
export interface ClipboardFileItem {
  kind: string;
  getAsFile: () => File | null;
}

/**
 * Files from a paste. Items of kind "string" are skipped — a text paste
 * stays a text paste.
 */
export function filesFromClipboard(
  items: ArrayLike<ClipboardFileItem> | null | undefined,
): File[] {
  if (!items) return [];
  const files: File[] = [];
  for (const item of Array.from(items)) {
    if (item.kind !== "file") continue;
    const file = item.getAsFile();
    if (file) files.push(file);
  }
  return files;
}

/**
 * True when a drag carries files. Dragged text and links report other
 * types, and the composer must not claim those drops.
 */
export function transferHasFiles(types: ArrayLike<string> | null | undefined): boolean {
  if (!types) return false;
  return Array.from(types).includes("Files");
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
    uploadProgress: null,
  };
}

/**
 * Payload builder for the send request — extract refs from files that have
 * completed upload successfully.
 */
/**
 * Payload builder for the send request — extract refs from files that have
 * completed upload successfully.
 */
export function toFileRefs(files: readonly ComposerFile[]): Array<{ ref: string }> {
  return files
    .filter((f) => f.attachmentRef)
    .map((f) => ({
      ref: f.attachmentRef!,
    }));
}
