import type {
  ExecResult,
  Sandbox,
  SandboxCapabilities,
  SandboxCreateOpts,
  SandboxProvider,
  SandboxStatus,
} from "@valet/engine";

/**
 * A minimal sandbox that lets workspace prep take its cold path without a
 * real container. File writes are no-ops, exec succeeds, and stat reports a
 * missing path.
 */
export class PrepFriendlySandbox implements Sandbox {
  constructor(readonly id: string) {}
  async readFile(): Promise<string> {
    return "";
  }
  async readBinary(): Promise<Uint8Array> {
    return new Uint8Array();
  }
  async writeFile(): Promise<void> {}
  async writeBinary(): Promise<void> {}
  async readdir(): Promise<string[]> {
    return [];
  }
  async stat(): Promise<{ isFile: boolean; isDirectory: boolean; size: number }> {
    throw new Error("ENOENT");
  }
  async mkdir(): Promise<void> {}
  async rm(): Promise<void> {}
  async exec(): Promise<ExecResult> {
    return { stdout: "", stderr: "", exitCode: 0 };
  }
  async destroy(): Promise<void> {}
}

/** Records sandbox create options for assertions without a real provider. */
export class RecordingSandboxProvider implements SandboxProvider {
  readonly backend = "recording-test";
  readonly createCalls: SandboxCreateOpts[] = [];
  private readonly sandboxes = new Map<string, PrepFriendlySandbox>();
  private nextId = 1;

  capabilities(): SandboxCapabilities {
    return {
      snapshot: "none",
      persistentWorkspace: true,
      tunnels: false,
      warmPool: false,
      hibernation: false,
      customImage: true,
    };
  }

  async create(opts: SandboxCreateOpts): Promise<Sandbox> {
    this.createCalls.push(opts);
    const id = `rec-${this.nextId++}`;
    const sandbox = new PrepFriendlySandbox(id);
    this.sandboxes.set(id, sandbox);
    return sandbox;
  }

  async restore(id: string): Promise<Sandbox> {
    const sandbox = this.sandboxes.get(id);
    if (!sandbox) throw new Error(`Recording sandbox not found: ${id}`);
    return sandbox;
  }

  async destroy(id: string): Promise<void> {
    this.sandboxes.delete(id);
  }

  async status(id: string): Promise<SandboxStatus> {
    return this.sandboxes.has(id)
      ? { id, state: "ready", startedAt: Date.now() }
      : { id, state: "released" };
  }
}
