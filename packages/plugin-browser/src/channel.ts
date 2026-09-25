import { randomUUID } from "node:crypto";
import type { Sandbox, SandboxCommandChannel } from "@valet/engine";
import type { BrowserRequest, BrowserResponse } from "@valet/shared";

const channels = new WeakMap<Sandbox, BrowserChannel>();
const uncertain = () => new Error(
  "The browser connection closed. The operation outcome may be unknown. Read browser status before retrying.",
);
interface Pending {
  resolve: (response: BrowserResponse) => void;
  reject: (error: Error) => void;
  cleanup: () => void;
}

/** One private exec connection per sandbox; requests are never replayed. */
class BrowserChannel {
  closed = false;
  private channel: SandboxCommandChannel | null = null;
  private opening: Promise<SandboxCommandChannel | null>;
  private pending = new Map<string, Pending>();
  private buffer = "";
  private idle?: ReturnType<typeof setTimeout>;

  constructor(sandbox: Sandbox, waitForReady: boolean) {
    this.opening = sandbox.openCommandChannel!(
      "/usr/local/bin/valet-browser-client --stream",
      {
        privileged: true,
        waitForReady,
        onData: (chunk) => this.receive(chunk),
        onClose: () => this.stop(uncertain()),
      },
    ).then((channel) => {
      if (this.closed) {
        channel?.close();
        throw uncertain();
      }
      this.channel = channel;
      this.armIdle();
      return channel;
    }).catch((error: unknown) => {
      this.stop(uncertain());
      throw error;
    });
  }

  async request(request: BrowserRequest, signal?: AbortSignal): Promise<BrowserResponse | null> {
    signal?.throwIfAborted();
    const channel = await this.opening;
    signal?.throwIfAborted();
    if (this.closed) throw uncertain();
    if (!channel) return null;
    // Leave four slots for dialog replies, cancellation, and approval resolution.
    const priority = request.command === "resolve" || request.command === "cancel" ||
      request.command === "revoke" || request.command === "control" ||
      (request.command === "input" && request.input.type === "dialog");
    if (this.pending.size >= (priority ? 16 : 12))
      throw new Error("The browser connection is busy. Wait for pending operations before continuing.");
    const id = randomUUID();
    const line = JSON.stringify({ id, request });
    if (Buffer.byteLength(line) > 512_000)
      throw new Error("The browser request exceeds the transport limit. Submit a smaller operation.");
    clearTimeout(this.idle);
    return new Promise<BrowserResponse>((resolve, reject) => {
      const timer = setTimeout(() => this.stop(uncertain()), 35_000);
      timer.unref?.();
      // A canceled caller stops waiting, but its remote request still owns a slot.
      const abort = () => reject(new Error(
        "The browser request was canceled. Read browser status before retrying an interaction.",
      ));
      const cleanup = () => {
        clearTimeout(timer);
        signal?.removeEventListener("abort", abort);
      };
      this.pending.set(id, { resolve, reject, cleanup });
      signal?.addEventListener("abort", abort, { once: true });
      // Any attempted write can have executed remotely. Do not retry after rejection.
      void channel.write(line + "\n").catch(() => this.stop(uncertain()));
    });
  }

  private receive(chunk: string): void {
    if (this.closed) return;
    this.buffer += chunk;
    try {
      for (;;) {
        const end = this.buffer.indexOf("\n");
        if (end < 0) break;
        const line = this.buffer.slice(0, end);
        this.buffer = this.buffer.slice(end + 1);
        if (Buffer.byteLength(line) > 1_000_000) throw new Error("oversized");
        const value: unknown = JSON.parse(line);
        if (!value || typeof value !== "object" || !("id" in value) ||
          typeof value.id !== "string" || !("response" in value) ||
          !value.response || typeof value.response !== "object") throw new Error("envelope");
        const pending = this.pending.get(value.id);
        if (!pending) throw new Error("unknown request");
        this.pending.delete(value.id);
        pending.cleanup();
        // browserRequest validates the response envelope before returning it to callers.
        pending.resolve(value.response as BrowserResponse);
      }
      if (Buffer.byteLength(this.buffer) > 1_000_000) throw new Error("oversized");
      this.armIdle();
    } catch {
      this.stop(new Error(
        "The browser returned an invalid transport response. Read browser status and update the sandbox image before retrying.",
      ));
    }
  }

  private armIdle(): void {
    clearTimeout(this.idle);
    if (this.closed || this.pending.size) return;
    this.idle = setTimeout(() => this.stop(uncertain()), 30_000);
    this.idle.unref?.();
  }

  private stop(error: Error): void {
    if (this.closed) return;
    this.closed = true;
    clearTimeout(this.idle);
    this.buffer = "";
    for (const pending of this.pending.values()) {
      pending.cleanup();
      pending.reject(error);
    }
    this.pending.clear();
    this.channel?.close();
  }
}

export async function browserChannelRequest(
  sandbox: Sandbox,
  request: BrowserRequest,
  signal?: AbortSignal,
): Promise<BrowserResponse | null> {
  signal?.throwIfAborted();
  if (!sandbox.openCommandChannel) return null;
  let channel = channels.get(sandbox);
  if (!channel || channel.closed) {
    channel = new BrowserChannel(sandbox, request.audience !== "viewer");
    channels.set(sandbox, channel);
  }
  return channel.request(request, signal);
}
