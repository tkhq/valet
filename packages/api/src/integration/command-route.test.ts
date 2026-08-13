/**
 * Integration tests for `GET /api/sessions/:id/commands` (slash-commands plan,
 * Task 10).
 *
 *   1. A saved user template appears in the merged registry next to built-ins.
 *   2. A repo template under `/workspace/.valet/prompts` appears only after
 *      workspace prep — the session's sandbox reads it once it is ready.
 */
import { describe, expect, it, afterEach } from "vitest";
import type {
  ExecOpts,
  ExecResult,
  Sandbox,
  SandboxCapabilities,
  SandboxCreateOpts,
  SandboxProvider,
  SandboxStatus,
} from "@valet/engine";
import { VirtualSandboxProvider } from "@valet/engine";
import { bootTestApi, type TestApi } from "./_setup.js";
import { userPromptTemplates } from "../schema/index.js";
import type { CreateSessionResponse, ListCommandsResponse } from "../wire/types.js";

const HEADERS = { "Content-Type": "application/json" };

let api: TestApi | undefined;

afterEach(async () => {
  await api?.cleanup();
  api = undefined;
});

async function createSession(baseUrl: string): Promise<string> {
  const res = await fetch(`${baseUrl}/api/sessions`, {
    method: "POST",
    headers: HEADERS,
    body: JSON.stringify({ workspace: "/tmp" }),
  });
  expect(res.status).toBe(201);
  const { id } = (await res.json()) as CreateSessionResponse;
  return id;
}

async function getCommands(baseUrl: string, sessionId: string): Promise<ListCommandsResponse> {
  const res = await fetch(`${baseUrl}/api/sessions/${sessionId}/commands`, { headers: HEADERS });
  expect(res.status).toBe(200);
  return (await res.json()) as ListCommandsResponse;
}

describe("GET /api/sessions/:id/commands", () => {
  it("merges a user template into the registry next to built-ins", async () => {
    api = await bootTestApi();
    const now = Date.now();
    await api.providers.db.insert(userPromptTemplates).values({
      id: "tmpl_standup",
      userId: "local-user",
      name: "standup",
      description: "Daily standup",
      content: "Summarize $1",
      createdAt: now,
      updatedAt: now,
    });

    const sessionId = await createSession(api.baseUrl);
    const body = await getCommands(api.baseUrl, sessionId);

    expect(body.commands.some((cmd) => cmd.name === "standup" && cmd.source === "template")).toBe(true);
    expect(body.commands.some((cmd) => cmd.name === "status" && cmd.source === "builtin")).toBe(true);
  });

  it("shows repo templates only after the sandbox is ready", async () => {
    const provider = new RepoTemplateSandboxProvider();
    api = await bootTestApi({ sandboxProvider: provider });

    const sessionId = await createSession(api.baseUrl);

    // Before prep: the sandbox is not provisioned, so the repo template is
    // absent from the registry.
    const before = await getCommands(api.baseUrl, sessionId);
    expect(before.commands.some((cmd) => cmd.name === "deploy")).toBe(false);

    // Provision the sandbox (workspace prep) then refresh the registry — the
    // same refresh the host runs on the attachment's `ready` transition.
    const session = api.providers.engineHost.liveSession(sessionId);
    expect(session).not.toBeNull();
    await session!.attachment.ensureReady({ timeoutMs: 5_000 });
    await session!.refreshCommandRegistry();

    const after = await getCommands(api.baseUrl, sessionId);
    expect(after.commands.some((cmd) => cmd.name === "deploy" && cmd.source === "template")).toBe(true);
  });
});

/**
 * A sandbox provider that answers the repo-template exec with one canned
 * `deploy.md` template and delegates every other operation to a real
 * `VirtualSandbox`. The virtual command parser doesn't understand the
 * `for`-loop glob the real provider runs, so the exec is intercepted here.
 */
class RepoTemplateSandboxProvider implements SandboxProvider {
  readonly backend = "virtual";
  private inner = new VirtualSandboxProvider();

  capabilities(): SandboxCapabilities {
    return this.inner.capabilities();
  }

  async create(opts: SandboxCreateOpts): Promise<Sandbox> {
    return new RepoTemplateSandbox(await this.inner.create(opts));
  }

  async restore(id: string): Promise<Sandbox> {
    return new RepoTemplateSandbox(await this.inner.restore(id));
  }

  destroy(id: string): Promise<void> {
    return this.inner.destroy(id);
  }

  status(id: string): Promise<SandboxStatus> {
    return this.inner.status(id);
  }
}

/** Wraps a raw `Sandbox`, intercepting only the repo-template exec. */
class RepoTemplateSandbox implements Sandbox {
  constructor(private readonly inner: Sandbox) {}

  get id(): string {
    return this.inner.id;
  }

  async exec(command: string, opts?: ExecOpts): Promise<ExecResult> {
    if (command.includes("/workspace/.valet/prompts/*.md")) {
      const stdout =
        "===VALET-TMPL /workspace/.valet/prompts/deploy.md\n" +
        "description: Deploy the app\n" +
        "Deploy $1 to $2\n";
      return { stdout, stderr: "", exitCode: 0 };
    }
    return this.inner.exec(command, opts);
  }

  readFile(path: string): Promise<string> {
    return this.inner.readFile(path);
  }
  readBinary(path: string): Promise<Uint8Array> {
    return this.inner.readBinary(path);
  }
  writeFile(path: string, content: string): Promise<void> {
    return this.inner.writeFile(path, content);
  }
  writeBinary(path: string, data: Uint8Array): Promise<void> {
    return this.inner.writeBinary(path, data);
  }
  readdir(path: string): Promise<string[]> {
    return this.inner.readdir(path);
  }
  stat(path: string): Promise<{ isFile: boolean; isDirectory: boolean; size: number }> {
    return this.inner.stat(path);
  }
  mkdir(path: string): Promise<void> {
    return this.inner.mkdir(path);
  }
  rm(path: string, opts?: { recursive?: boolean }): Promise<void> {
    return this.inner.rm(path, opts);
  }
  async destroy(): Promise<void> {
    await this.inner.destroy?.();
  }
}
