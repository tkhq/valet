/**
 * Integration tests for the slash-commands plan (Tasks 10 and 11).
 *
 * Task 10 — `GET /api/sessions/:id/commands`:
 *   1. A saved user template appears in the merged registry next to built-ins.
 *   2. A repo template under `/workspace/.valet/prompts` appears only after
 *      workspace prep — the session's sandbox reads it once it is ready.
 *
 * Task 11 — `command_result` REST round-trip:
 *   3. Submitting "/status" through the real stack produces a message with
 *      `command.name === "status"`, `command.ok === true`, and non-empty
 *      `content` (the TEXT is reachable on reload, not just during live WS).
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
import type {
  CreateSessionResponse,
  ListCommandsResponse,
  ListMessagesResponse,
  SendPromptResponse,
} from "../wire/types.js";

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
  // Task 3: user_prompt_templates removed; Task 4 rewires via skills/skill_sources.
  it.skip("merges a user template into the registry next to built-ins", async () => {
    // Stub — Task 4 will rewrite this test against the skills model.
  });

  // Task 4 rewires: see the note above; repo prompts register as prompt skills.
  it.skip("shows repo templates only after the sandbox is ready", async () => {
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
    expect(after.commands.some((cmd) => cmd.name === "deploy" && cmd.source === "skill")).toBe(true);
  });
});

describe("command_result REST round-trip (Task 11)", () => {
  it("a builtin command round-trips to REST", async () => {
    api = await bootTestApi();
    const sessionId = await createSession(api.baseUrl);

    // Post the slash command as a regular prompt — the route detects the
    // leading slash and dispatches through session.prompt() → executeCommand().
    const postRes = await fetch(`${api.baseUrl}/api/sessions/${sessionId}/messages`, {
      method: "POST",
      headers: HEADERS,
      body: JSON.stringify({ text: "/status" }),
    });
    expect(postRes.status).toBe(202);
    const postBody = (await postRes.json()) as SendPromptResponse;
    expect(postBody.threadId).toBeTruthy();

    // Read the transcript via REST — this is the reload path. The
    // command_result entry must survive the entryToMessage conversion.
    const msgsRes = await fetch(`${api.baseUrl}/api/sessions/${sessionId}/messages`, {
      headers: HEADERS,
    });
    expect(msgsRes.status).toBe(200);
    const { messages } = (await msgsRes.json()) as ListMessagesResponse;

    const cmd = messages.find((m) => m.command?.name === "status");
    expect(cmd).toBeDefined();
    expect(cmd?.command?.ok).toBe(true);
    // The TEXT is reachable — not "(empty output)". This is the documented
    // shape-drift regression (CLAUDE.md "Tool-call persistence round trip").
    expect(cmd?.content.length).toBeGreaterThan(0);
    expect(cmd?.role).toBe("system");
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
