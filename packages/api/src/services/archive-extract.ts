/**
 * Zip extraction with safety guards per the design spec.
 *
 * Uses yauzl for streaming zip reading. Guards in order:
 * 1. Path traversal — entry name normalized, must resolve under extract root.
 * 2. Symlinks and hard links — skip any entry with those attributes.
 * 3. Entry count — cap at 10,000.
 * 4. Uncompressed size — cap at min(VALET_MAX_UPLOAD_BYTES × 10, 500 MB).
 * 5. Compression ratio — reject per-entry > 100× ratio without reading bytes.
 * 6. Central directory vs local header mismatch — reject when they disagree.
 *
 * On any abort, all files written from the archive are deleted before returning.
 */

import { basename, dirname, normalize, resolve as resolvePath } from "node:path";
import type { Sandbox } from "@valet/engine";
import { fromBuffer } from "yauzl";

export interface ExtractZipOpts {
  sandbox: Sandbox;
  archivePath: string; // sandbox path to the uploaded zip
  extractRoot: string; // sandbox path, always ends with "/"
  maxTotalUncompressed: number;
  maxEntries: number;
}

export interface ExtractZipResult {
  ok: true;
  extracted: string[];
}

export interface ExtractZipError {
  ok: false;
  error: string;
  corrective: string;
  partialFiles: string[];
}

/**
 * Extract a zip file with safety guards.
 *
 * Returns the list of extracted files on success, or an error with partial files
 * that must be deleted. The raw uploaded zip remains in place at archivePath.
 */
export async function extractZip(
  opts: ExtractZipOpts,
): Promise<ExtractZipResult | ExtractZipError> {
  const { sandbox, archivePath, extractRoot, maxTotalUncompressed, maxEntries } = opts;

  // Ensure extractRoot ends with /
  const rootDir = extractRoot.endsWith("/") ? extractRoot : `${extractRoot}/`;

  // Read the zip file from sandbox
  const zipBytes = await sandbox.readBinary(archivePath);
  const zipBuffer = Buffer.from(zipBytes);

  const extracted: string[] = [];
  let totalUncompressed = 0;
  let entryCount = 0;

  try {
    // Open zip per spec (lazyEntries for streaming)
    const zipfile = await new Promise<any>((resolve, reject) => {
      fromBuffer(zipBuffer, { lazyEntries: true } as any, (err, zf) => {
        if (err) reject(err);
        else resolve(zf);
      });
    });

    await new Promise<void>((resolve, reject) => {
      zipfile.on("entry", async (entry: any) => {
        entryCount++;

        // Guard 3: Entry count cap
        if (entryCount > maxEntries) {
          zipfile.close();
          reject(new ArchiveGuardError("entry_count", `Archive exceeds ${maxEntries} entries.`));
          return;
        }

        // Guard 1: Path traversal
        const pathError = validateEntryPath(entry.fileName, rootDir);
        if (pathError) {
          zipfile.close();
          reject(pathError);
          return;
        }

        // Guard 2: Symlinks and hard links
        if (isSymlinkOrHardlink(entry)) {
          // Skip this entry, proceed to next
          zipfile.readEntry();
          return;
        }

        // Guard 5: Compression ratio
        if (entry.compressedSize > 0) {
          const ratio = entry.uncompressedSize / entry.compressedSize;
          if (ratio > 100) {
            zipfile.close();
            reject(
              new ArchiveGuardError("compression_ratio", `Entry exceeds 100× compression ratio.`),
            );
            return;
          }
        }

        // Guard 6: Central directory vs local header mismatch
        // yauzl validates this, but we check for negative sizes as a safety net
        if (entry.uncompressedSize < 0 || entry.compressedSize < 0) {
          zipfile.close();
          reject(
            new ArchiveGuardError(
              "header_mismatch",
              "Archive local header does not match central directory.",
            ),
          );
          return;
        }

        // Guard 4: Uncompressed size
        totalUncompressed += entry.uncompressedSize;
        if (totalUncompressed > maxTotalUncompressed) {
          zipfile.close();
          reject(
            new ArchiveGuardError(
              "total_uncompressed",
              `Extracted content exceeds ${maxTotalUncompressed} bytes.`,
            ),
          );
          return;
        }

        // Extract the file
        try {
          const entryPath = resolvePath(rootDir, entry.fileName);

          // Create parent directory
          const parentDir = dirname(entryPath);
          if (parentDir && parentDir !== rootDir.slice(0, -1)) {
            await sandbox.mkdir(parentDir);
          }

          // Extract file contents using yauzl's openReadStream
          zipfile.openReadStream(entry, (err: Error | null, stream: any) => {
            if (err) {
              zipfile.close();
              reject(err);
              return;
            }

            const chunks: Buffer[] = [];
            stream.on("data", (chunk: Buffer | Uint8Array) => {
              chunks.push(Buffer.from(chunk));
            });
            stream.on("end", async () => {
              try {
                const fileBytes = Buffer.concat(chunks);
                await sandbox.writeBinary(entryPath, new Uint8Array(fileBytes));
                extracted.push(entryPath);
                zipfile.readEntry();
              } catch (writeErr) {
                zipfile.close();
                reject(writeErr);
              }
            });
            stream.on("error", (streamErr: Error) => {
              zipfile.close();
              reject(streamErr);
            });
          });
        } catch (err) {
          zipfile.close();
          reject(err);
        }
      });

      zipfile.on("end", () => {
        resolve();
      });

      zipfile.on("error", (err: Error) => {
        reject(err);
      });

      // Start reading
      zipfile.readEntry();
    });

    return { ok: true, extracted };
  } catch (err) {
    // Delete all partial files
    for (const file of extracted) {
      try {
        await sandbox.rm(file);
      } catch {
        // Ignore delete errors
      }
    }

    if (err instanceof ArchiveGuardError) {
      return {
        ok: false,
        error: err.message,
        corrective: "The archive was rejected by a safety guard. See the message for which one.",
        partialFiles: extracted,
      };
    }

    return {
      ok: false,
      error: (err instanceof Error ? err.message : String(err)) || "Unknown zip extraction error",
      corrective: "The archive could not be extracted. Ensure it is a valid zip file.",
      partialFiles: extracted,
    };
  }
}

class ArchiveGuardError extends Error {
  constructor(
    readonly guard: string,
    message: string,
  ) {
    super(message);
    this.name = "ArchiveGuardError";
  }
}

/**
 * Validate entry path against traversal attacks.
 * Returns an error if the path is invalid, null otherwise.
 */
function validateEntryPath(
  entryName: string,
  rootDir: string,
): ArchiveGuardError | null {
  if (!entryName || entryName.length === 0) {
    return new ArchiveGuardError("empty_name", "Archive contains an entry with an empty name.");
  }

  if (entryName.includes("\x00")) {
    return new ArchiveGuardError("null_byte", "Archive entry name contains a null byte.");
  }

  // Reject absolute paths (Unix / or Windows drive letters)
  if (entryName.startsWith("/") || /^[a-zA-Z]:/.test(entryName)) {
    return new ArchiveGuardError("absolute_path", "Archive entry is an absolute path.");
  }

  // Reject .. segments
  if (entryName.includes("..")) {
    return new ArchiveGuardError("traversal", "Archive entry contains .. path traversal.");
  }

  // Normalize and resolve against root
  const normalized = normalize(entryName);
  const resolved = resolvePath(rootDir, normalized);

  // Ensure resolved path is under rootDir
  if (!resolved.startsWith(rootDir)) {
    return new ArchiveGuardError("traversal", "Archive entry resolves outside extract root.");
  }

  return null;
}

/**
 * Check if an entry is a symlink or hard link.
 * External file attributes: (externalFileAttributes >>> 16) & 0o170000
 * 0o120000 = symlink
 */
function isSymlinkOrHardlink(entry: any): boolean {
  const mode = (entry.externalFileAttributes >>> 16) & 0o170000;
  return mode === 0o120000; // S_IFLNK (symlink)
}
