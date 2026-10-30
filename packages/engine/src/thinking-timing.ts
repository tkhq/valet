import type { MessagePart } from "./types.js";

type ThinkingPart = Extract<MessagePart, { type: "thinking" }>;

/** Longest reasoning summary kept for display. Bounds what each entry stores. */
export const MAX_THINKING_SUMMARY_CHARS = 16_000;

/**
 * Measure observed thinking events and keep each block's reasoning summary for
 * display. Providers may send summaries after hidden compute. The summary
 * never becomes part `text`, which is what a rebuilt transcript sends back to
 * the model.
 */
export class ThinkingTiming {
  private blocks = new Map<number, { startedAt: number; durationMs?: number }>();
  private summaries = new Map<number, string>();

  start(index: number, now: number): void {
    if (!this.blocks.has(index)) this.blocks.set(index, { startedAt: now });
  }

  end(index: number, now: number): void {
    const block = this.blocks.get(index);
    if (block && block.durationMs === undefined) block.durationMs = Math.max(0, now - block.startedAt);
  }

  finish(now: number): number[] {
    const finished: number[] = [];
    for (const [index, block] of this.blocks) {
      if (block.durationMs !== undefined) continue;
      this.end(index, now);
      finished.push(index);
    }
    return finished;
  }

  /** Record a block's reasoning summary so far. A redacted block carries an
   * opaque payload, not reasoning, so it records nothing. */
  summarize(index: number, block: { thinking: string; redacted?: boolean }): void {
    if (block.redacted === true || block.thinking.trim() === "") return;
    this.summaries.set(index, block.thinking.slice(0, MAX_THINKING_SUMMARY_CHARS));
  }

  part(index: number): ThinkingPart {
    const summary = this.summaries.get(index);
    return { type: "thinking", text: "", ...(summary !== undefined ? { summary } : {}), ...this.blocks.get(index) };
  }
}
