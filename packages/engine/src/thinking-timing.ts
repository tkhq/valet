import type { MessagePart } from "./types.js";

type ThinkingPart = Extract<MessagePart, { type: "thinking" }>;

/** Measure observed thinking events. Providers may send summaries after hidden compute. */
export class ThinkingTiming {
  private blocks = new Map<number, { startedAt: number; durationMs?: number }>();

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

  part(index: number): ThinkingPart {
    return { type: "thinking", text: "", ...this.blocks.get(index) };
  }
}
