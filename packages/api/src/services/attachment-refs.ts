/**
 * Per-session in-memory attachment reference store with 15-minute TTL.
 *
 * Refs are minted on successful upload and consumed (single-use) when the client
 * sends a message with the attachment. The store is process-local; API restart
 * forgets every outstanding ref. Per-session Map fences cross-session use.
 *
 * Each ref is prefixed `att_` and is 128 bits of crypto.randomBytes(16).toString("hex").
 */

import { randomBytes } from "node:crypto";

export interface AttachmentInfo {
  ref: string;
  sessionId: string; // fenced — reject cross-session use
  createdAt: number;
  path: string;
  bytes: number;
  sha256: string;
  mimeType?: string;
  markdownPath?: string; // for PDFs with a text sidecar
  extractedTo?: string; // extract root for a zip that was extracted
  extractedFiles?: string[]; // full listing of extracted files
  name: string; // display name (basename of path)
}

const TTL_MS = 15 * 60 * 1000; // 15 minutes

/**
 * Per-session attachment ref store.
 */
class AttachmentRefStore {
  private store = new Map<string, Map<string, AttachmentInfo>>(); // sessionId -> (ref -> info)
  private sweepHandle: NodeJS.Timeout | null = null;

  /**
   * Mint a new attachment reference for the given session.
   * Returns a ref string like "att_abc123...".
   */
  mint(sessionId: string, info: Omit<AttachmentInfo, "ref" | "sessionId" | "createdAt">): string {
    const ref = `att_${randomBytes(16).toString("hex")}`;
    const now = Date.now();

    let sessionMap = this.store.get(sessionId);
    if (!sessionMap) {
      sessionMap = new Map();
      this.store.set(sessionId, sessionMap);
    }

    sessionMap.set(ref, {
      ref,
      sessionId,
      createdAt: now,
      ...info,
    });

    return ref;
  }

  /**
   * Consume a ref (single-use, removes on read).
   * Returns the info if found and not expired, null otherwise.
   */
  consume(sessionId: string, ref: string): AttachmentInfo | null {
    const sessionMap = this.store.get(sessionId);
    if (!sessionMap) return null;

    const info = sessionMap.get(ref);
    if (!info) return null;

    // Check TTL
    const age = Date.now() - info.createdAt;
    if (age > TTL_MS) {
      sessionMap.delete(ref);
      return null;
    }

    // Single-use: delete after consuming
    sessionMap.delete(ref);

    // Clean up empty session map
    if (sessionMap.size === 0) {
      this.store.delete(sessionId);
    }

    return info;
  }

  /**
   * Start a TTL sweep that removes entries older than 15 minutes.
   * Returns a stop function.
   */
  startSweep(intervalMs: number = 60 * 1000): () => void {
    if (this.sweepHandle) {
      clearInterval(this.sweepHandle);
    }

    this.sweepHandle = setInterval(() => {
      const now = Date.now();

      for (const [sessionId, sessionMap] of this.store.entries()) {
        for (const [ref, info] of sessionMap.entries()) {
          if (now - info.createdAt > TTL_MS) {
            sessionMap.delete(ref);
          }
        }

        // Clean up empty session maps
        if (sessionMap.size === 0) {
          this.store.delete(sessionId);
        }
      }
    }, intervalMs);

    return () => {
      if (this.sweepHandle) {
        clearInterval(this.sweepHandle);
        this.sweepHandle = null;
      }
    };
  }

  /**
   * For testing: get the total size of the store.
   */
  _size(): number {
    let total = 0;
    for (const sessionMap of this.store.values()) {
      total += sessionMap.size;
    }
    return total;
  }
}

// Singleton instance
let instance: AttachmentRefStore | null = null;

export function getAttachmentRefStore(): AttachmentRefStore {
  if (!instance) {
    instance = new AttachmentRefStore();
  }
  return instance;
}

/**
 * Reset the store (for testing).
 */
export function resetAttachmentRefStore(): void {
  if (instance) {
    instance.startSweep(); // Stop any running sweep
  }
  instance = null;
}
