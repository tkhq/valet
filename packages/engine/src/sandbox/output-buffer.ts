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
export class CappedOutputBuffer {
  private head = "";
  private tail = "";
  private dropped = 0;
  private readonly headMax: number;
  private readonly tailMax: number;

  constructor(limit: number) {
    // 1/4 head, 3/4 tail: the end of the output is where test runners and
    // builds put the information the caller came for.
    this.headMax = Math.max(1, Math.floor(limit / 4));
    this.tailMax = Math.max(1, limit - this.headMax);
  }

  append(chunk: string): void {
    const headRoom = this.headMax - this.head.length;
    if (headRoom > 0) {
      this.head += chunk.slice(0, headRoom);
      chunk = chunk.slice(headRoom);
    }
    if (chunk.length === 0) return;
    const grown = this.tail + chunk;
    this.dropped += Math.max(0, grown.length - this.tailMax);
    this.tail = grown.slice(-this.tailMax);
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
    if (this.tail.length === 0) return "";
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
