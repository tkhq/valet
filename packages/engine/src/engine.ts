import { VirtualSandboxProvider } from "./providers/sandbox/virtual.js";
import { Session } from "./session.js";
import { SandboxAttachment } from "./sandbox/attachment.js";
import { PolicySandbox } from "./sandbox/policy.js";
import type {
  CreateSessionOptions,
  EngineOptions,
  RestoreSessionOptions,
  Sandbox,
  SandboxCreateOpts,
  SpecProvider,
} from "./types.js";

let nextId = 1;
function uid(prefix: string): string {
  return `${prefix}-${Date.now().toString(36)}-${(nextId++).toString(36)}`;
}

export class Engine {
  private sessions = new Map<string, Session>();
  private opts: EngineOptions;

  constructor(opts: EngineOptions) {
    this.opts = opts;
  }

  async createSession(opts: CreateSessionOptions): Promise<Session> {
    const id = opts.id ?? uid("sess");
    if (this.sessions.has(id)) return this.sessions.get(id)!;

    const { attachment, sandbox, policySandbox } = await this.materializeSandbox(
      id,
      opts.sandbox,
      opts.sandboxReadyTimeoutMs,
      opts.specProvider,
    );
    const session = new Session(id, opts, this.opts.providers, sandbox, attachment, policySandbox);
    this.sessions.set(id, session);

    await this.opts.providers.store.saveSession(await session.toData());
    return session;
  }

  async restoreSession(args: RestoreSessionOptions): Promise<Session> {
    const cached = this.sessions.get(args.sessionId);
    if (cached) return cached;
    const data = await this.opts.providers.store.getSession(args.sessionId);
    if (!data) throw new Error(`session not found: ${args.sessionId}`);
    const { attachment, sandbox, policySandbox } = await this.materializeSandbox(
      args.sessionId,
      args.options.sandbox,
      args.options.sandboxReadyTimeoutMs,
      args.options.specProvider,
    );
    const session = await Session.rehydrate(
      data,
      { ...args.options, id: args.sessionId },
      this.opts.providers,
      sandbox,
      attachment,
      policySandbox,
    );
    this.sessions.set(args.sessionId, session);
    return session;
  }

  getSession(sessionId: string): Session | null {
    return this.sessions.get(sessionId) ?? null;
  }

  async deleteSession(sessionId: string): Promise<void> {
    const s = this.sessions.get(sessionId);
    if (s) await s.destroy();
    this.sessions.delete(sessionId);
  }

  /**
   * Builds the {@link SandboxAttachment} + {@link PolicySandbox} pair for a
   * session (spec decision 5). A concrete `Sandbox` arg produces a
   * ready-at-epoch-1 attachment (`SandboxAttachment.forSandbox`); a
   * `SandboxCreateOpts` (or undefined) produces a `detached` attachment over
   * the configured provider — `provider.create` is never awaited here.
   * Neither `createSession` nor `restoreSession` warms it; the first claimed
   * turn does (`Thread.runTurn`).
   */
  private async materializeSandbox(
    sessionId: string,
    arg: Sandbox | SandboxCreateOpts | undefined,
    readyTimeoutMs: number | undefined,
    specProvider?: SpecProvider,
  ): Promise<{ attachment: SandboxAttachment; sandbox: Sandbox; policySandbox: PolicySandbox }> {
    let attachment: SandboxAttachment;
    if (arg && typeof (arg as Sandbox).readFile === "function") {
      // A concrete pre-provisioned handle is ready at epoch 1 and never runs
      // `doProvision`, so there is no cold-boot point at which prep could run —
      // the host is responsible for prepping a sandbox it hands in ready.
      attachment = SandboxAttachment.forSandbox(arg as Sandbox);
    } else {
      const provider = this.opts.providers.sandboxProvider ?? new VirtualSandboxProvider();
      // Stamp the owning session on the create opts so providers with a
      // `list()` seam can map the backing resource to its session — the
      // reconcile sweep's orphan detection depends on it. The stamp is
      // applied AFTER the spread and unconditionally: an opts object cloned
      // from another session (or carrying an explicit `sessionId: undefined`
      // key) must never annotate the sandbox with the wrong owner.
      const createOpts: SandboxCreateOpts = { ...((arg ?? {}) as SandboxCreateOpts), sessionId };
      attachment = new SandboxAttachment(provider, createOpts, specProvider);
    }
    const policySandbox = new PolicySandbox(attachment, { readyTimeoutMs });
    return { attachment, sandbox: policySandbox, policySandbox };
  }
}
