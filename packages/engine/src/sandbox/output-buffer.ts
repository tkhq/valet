/**
 * Bounded capture of one output stream that keeps the HEAD and the TAIL
 * and drops the middle (the sandbox `maxOutputBytes` cap). Test runners
 * and builds print their summary last, so a head-only cap loses exactly
 * the bytes the caller needs; keeping both ends bounds memory while
 * preserving the useful parts.
 *
 * Two consumption modes, one buffer:
 * - Sync exec joins the whole thing at process exit via `value()`.
 * - Job-mode exec streams through an offset-based poll protocol that
 *   requires an APPEND-ONLY buffer. `headText` only ever grows, so it is
 *   safe to expose live; `appendix()` (the tail, plus an omission marker
 *   when bytes were dropped) is appended once, at process exit, and the
 *   final polls deliver it as ordinary deltas.
 */
function utf8CodePointBytes(codePoint: string): number {
  const value = codePoint.codePointAt(0);
  if (value === undefined) return 0;
  if (value <= 0x7f) return 1;
  if (value <= 0x7ff) return 2;
  if (value <= 0xffff) return 3;
  return 4;
}

function utf8ByteLength(value: string): number {
  let bytes = 0;
  for (const codePoint of value) bytes += utf8CodePointBytes(codePoint);
  return bytes;
}

export class CappedOutputBuffer {
  private head = "";
  private headBytes = 0;
  private tail = "";
  private tailBytes = 0;
  private dropped = 0;
  private pendingHighSurrogate = "";
  private headSealed: boolean;
  private readonly headMax: number;
  private readonly tailMax: number;

  constructor(limit: number) {
    if (!Number.isFinite(limit)) {
      throw new RangeError("maxOutputBytes must be finite. Set a finite non-negative integer.");
    }
    const normalizedLimit = Math.min(Number.MAX_SAFE_INTEGER, Math.max(0, Math.floor(limit)));
    // 1/4 head, 3/4 tail: the end of the output is where test runners and
    // builds put the information the caller came for.
    this.headMax = Math.floor(normalizedLimit / 4);
    this.tailMax = normalizedLimit - this.headMax;
    this.headSealed = this.headMax === 0;
  }

  append(chunk: string): void {
    if (chunk.length === 0) return;

    if (this.pendingHighSurrogate.length > 0) {
      chunk = this.pendingHighSurrogate + chunk;
      this.pendingHighSurrogate = "";
    }
    const lastCodeUnit = chunk.charCodeAt(chunk.length - 1);
    if (lastCodeUnit >= 0xd800 && lastCodeUnit <= 0xdbff) {
      this.pendingHighSurrogate = chunk.slice(-1);
      chunk = chunk.slice(0, -1);
    }
    if (chunk.length === 0) return;

    // Replace only malformed standalone surrogate code units. A valid pair
    // stays intact, including when two append calls split that pair.
    let completeChunk = "";
    for (const codePoint of chunk) {
      const value = codePoint.codePointAt(0);
      completeChunk +=
        value !== undefined && value >= 0xd800 && value <= 0xdfff ? "\ufffd" : codePoint;
    }

    const headRoom = this.headMax - this.headBytes;
    let prefixEnd = 0;
    let prefixBytes = 0;
    if (!this.headSealed && headRoom > 0) {
      for (const codePoint of completeChunk) {
        const bytes = utf8CodePointBytes(codePoint);
        if (prefixBytes + bytes > headRoom) {
          this.headSealed = true;
          break;
        }
        prefixBytes += bytes;
        prefixEnd += codePoint.length;
      }
      this.head += completeChunk.slice(0, prefixEnd);
      this.headBytes += prefixBytes;
    }

    const remainder = completeChunk.slice(prefixEnd);
    if (remainder.length === 0) return;
    const grown = this.tail + remainder;
    const grownBytes = this.tailBytes + utf8ByteLength(remainder);
    let suffixStart = grown.length;
    let suffixBytes = 0;

    while (suffixStart > 0) {
      let codePointStart = suffixStart - 1;
      const last = grown.charCodeAt(codePointStart);
      if (last >= 0xdc00 && last <= 0xdfff && codePointStart > 0) {
        const previous = grown.charCodeAt(codePointStart - 1);
        if (previous >= 0xd800 && previous <= 0xdbff) codePointStart--;
      }
      const bytes = utf8CodePointBytes(grown.slice(codePointStart, suffixStart));
      if (suffixBytes + bytes > this.tailMax) break;
      suffixBytes += bytes;
      suffixStart = codePointStart;
    }

    this.dropped += grownBytes - suffixBytes;
    this.tail = grown.slice(suffixStart);
    this.tailBytes = suffixBytes;
  }

  /** The append-only prefix — safe to expose while the process runs. */
  get headText(): string {
    return this.head;
  }

  /** True once the cap actually dropped bytes (not merely filled up). */
  get truncated(): boolean {
    return this.dropped > 0;
  }

  /**
   * Everything past the head, for joining on at process exit: the tail
   * preceded by an omission marker when bytes were dropped. Empty when the
   * whole output fit in the head.
   */
  appendix(): string {
    if (this.dropped === 0) return this.tail;
    return `${omittedMarker(this.dropped)}${this.tail}`;
  }

  /** The full bounded capture: head + appendix. */
  value(): string {
    return this.head + this.appendix();
  }
}

/** The in-band marker for bytes the cap dropped between head and tail. */
export function omittedMarker(bytes: number): string {
  return `\n[... ${bytes} bytes omitted: output capped, head and tail kept ...]\n`;
}
