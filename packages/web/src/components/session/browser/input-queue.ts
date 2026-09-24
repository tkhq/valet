import type { BrowserHumanInput } from "@valet/shared";

/** Preserve input order without retaining every move from a slow connection. */
export class BrowserInputQueue {
  private pending: BrowserHumanInput[] = [];
  private running = false;
  private stopped = false;
  constructor(
    private send: (input: BrowserHumanInput) => Promise<void>,
    private onError: (message: string) => void,
  ) {}

  add(input: BrowserHumanInput): void {
    if (this.stopped) return;
    const previous = this.pending.at(-1);
    if (
      input.type === "pointer" &&
      input.phase === "move" &&
      previous?.type === "pointer" &&
      previous.phase === "move"
    )
      this.pending[this.pending.length - 1] = input;
    else if (input.type === "wheel" && previous?.type === "wheel")
      this.pending[this.pending.length - 1] = {
        type: "wheel",
        deltaX: previous.deltaX + input.deltaX,
        deltaY: previous.deltaY + input.deltaY,
      };
    else this.pending.push(input);
    if (this.pending.length > 64) {
      this.dispose();
      this.onError(
        "Browser input is too slow. Release control and reconnect before continuing.",
      );
      return;
    }
    void this.drain();
  }

  dispose(): void {
    this.stopped = true;
    this.pending = [];
  }

  private async drain(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      while (!this.stopped) {
        const input = this.pending.shift();
        if (!input) break;
        await this.send(input);
      }
    } catch (error) {
      this.dispose();
      this.onError(
        error instanceof Error
          ? error.message
          : "Browser input failed. Refresh browser status before continuing.",
      );
    } finally {
      this.running = false;
    }
  }
}
