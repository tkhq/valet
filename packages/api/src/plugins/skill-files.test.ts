import { fauxAssistantMessage, fauxToolCall, registerFauxProvider } from "@earendil-works/pi-ai/compat";
import { DockerSandbox } from "@valet/sandbox-docker";
import { tmpdir } from "node:os";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { Engine, InMemoryEventStream, InMemorySessionStore, VirtualSandboxProvider, bashTool, VirtualSandbox, type Sandbox, type ToolDef, type SkillFile, type SkillSource, type ToolContext } from "@valet/engine";
import { LocalSandbox } from "@valet/sandbox-local";
import { buildSkillTool } from "./skill-tool.js";
import { buildSkillScriptTool } from "./skill-script-tool.js";

function skillContext(sandbox: Sandbox = new VirtualSandbox("test")): ToolContext {
  return {
    userId: "u1", orgId: "o1", sessionId: "s1", threadId: "t1", sandbox,
    credentials: { get: async () => null, request: async () => { throw new Error("unused"); } },
    requestDecision: async () => { throw new Error("unused"); },
    signal: new AbortController().signal, threadRead: async () => [], listThreads: async () => [],
    setModel: async ({ model }) => ({ fromModel: model, toModel: model }),
  };
}

function file(path: string, text: string, mode = "100644"): SkillFile {
  const bytes = Buffer.from(text);
  return { path, bytes, mode, blobSha: text, size: bytes.length };
}
const fixture: SkillSource = { name: "check-reply", content: "Read the reference, then run the check.", files: [
  file("references/x.md", "Reference text."),
  file("assets/data.bin", "\0\xff"),
  file("scripts/check.py", "print('checked')", "100755"),
  file("scripts/lib/util.py", "# helper"),
] };

describe("skill companion tools", () => {
  it("lists stored files without writing them", async () => {
    const ctx = skillContext();
    const write = vi.spyOn(ctx.sandbox, "writeBinary");
    const record = vi.fn();
    ctx.recordSkillInvocation = record;
    const tool = buildSkillTool([fixture])!;
    expect((await tool.execute({ name: fixture.name }, ctx)).text).toContain("references/x.md");
    expect((await tool.execute({ name: fixture.name, path: "references/x.md" }, ctx)).text).toBe("Reference text.");
    expect(record.mock.calls[1]?.[1]).toBe("file_read");
    expect(tool.protectedFromPruning).toBe(true);
    expect(write).not.toHaveBeenCalled();
  });

  it("returns a 17 KB reference whole and pages larger references up to 64 KiB", async () => {
    const reference = "x".repeat(16_931);
    const large = "a".repeat(65_536) + "b".repeat(20_000);
    const source = { ...fixture, files: [file("references/examples.md", reference), file("references/large.md", large)] };
    const tool = buildSkillTool([source])!;
    expect(tool.description).toContain("65536");
    expect((await tool.execute({ name: source.name, path: "references/examples.md" }, skillContext())).text).toBe(reference);
    expect((await tool.execute({ name: source.name, path: "references/large.md" }, skillContext())).text).toBe("a".repeat(65_536));
    expect((await tool.execute({ name: source.name, path: "references/large.md", offset: 65_536 }, skillContext())).text).toBe("b".repeat(20_000));
    expect((await tool.execute({ name: source.name, path: "references/large.md", offset: 65_536, limit: 300 }, skillContext())).text).toBe("b".repeat(300));
    expect((await tool.execute({ name: source.name, path: "references/large.md", offset: 100_000 }, skillContext())).text).toBe("");
    expect((await tool.execute({ name: source.name, offset: 0 }, skillContext())).text).toContain("[skill_bad_range]");
  });

  it("keeps pages valid UTF-8 and rejects offsets inside a character", async () => {
    const source = { ...fixture, files: [file("references/x.md", "aé🙂z")] };
    const tool = buildSkillTool([source])!;
    const args = { name: source.name, path: "references/x.md" };
    expect((await tool.execute({ ...args, limit: 2 }, skillContext())).text).toBe("a");
    expect((await tool.execute({ ...args, offset: 1, limit: 2 }, skillContext())).text).toBe("é");
    expect((await tool.execute({ ...args, offset: 3, limit: 4 }, skillContext())).text).toBe("🙂");
    expect((await tool.execute({ ...args, offset: 2 }, skillContext())).text).toContain("[skill_bad_range]");
    expect((await tool.execute({ ...args, offset: 3, limit: 1 }, skillContext())).text).toContain("[skill_bad_range]");
  });

  it("loads only the requested bytes and refreshes an unknown script name at most once", async () => {
    const readFile = vi.fn(async () => Buffer.from("reference"));
    const source = { ...fixture, files: [{ path: "references/x.md", size: 9, mode: "100644", blobSha: "sha" }], readFile };
    const skill = buildSkillTool([source])!;
    await skill.execute({ name: source.name }, skillContext());
    expect(readFile).not.toHaveBeenCalled();
    await skill.execute({ name: source.name, path: "references/x.md" }, skillContext());
    expect(readFile).toHaveBeenCalledTimes(1);
    const refreshSkills = vi.fn(async () => {});
    const tool = buildSkillScriptTool([], () => ({ skills: new Map(), refreshSkills }));
    for (let i = 0; i < 3; i++) await tool.execute({ name: "missing", script: "scripts/x.py" }, skillContext());
    expect(refreshSkills).toHaveBeenCalledTimes(1);
  });

  it.each(["owner", "external", "guest", "scope"] as const)("shares bash's native approval and policy path for %s", async (actor) => {
    const faux = registerFauxProvider({ provider: `skill-script-policy-${actor}` });
    try {
      const script = buildSkillScriptTool([fixture]);
      // Engine registration erases the static schema. The bridge validates arguments.
      const bash = { ...bashTool } as ToolDef;
      const scriptExecute = vi.spyOn(script, "execute");
      const bashExecute = vi.spyOn(bash, "execute");
      const stream = new InMemoryEventStream();
      const gates: string[] = [];
      stream.subscribe({}, (event) => { if (event.event.type === "decision_gate") gates.push(event.event.type); });
      const engine = new Engine({ providers: { store: new InMemorySessionStore(), stream, sandboxProvider: new VirtualSandboxProvider() } });
      const session = await engine.createSession({ userId: "u1", orgId: "o1", owner: { type: "user", id: "u1" },
        workspace: "/", sandbox: {}, model: faux.getModel(), builtinTools: [], tools: [bash, script],
        ...(actor === "scope" ? { toolScope: { tools: ["read"] } } : {}),
      });
      faux.setResponses([fauxAssistantMessage([
        fauxToolCall("bash", { command: "echo checked", timeout: 1 }),
        fauxToolCall("skill_script", { name: fixture.name, script: "scripts/check.py", timeout: 1 }),
      ], { stopReason: "toolUse" }), fauxAssistantMessage("done")]);
      const receipt = await session.prompt("Run the two native tools", { author: {
        id: actor === "guest" ? "other" : "u1", ...(actor === "external" ? { externalSender: true } : {}),
      } });
      await session.thread().awaitResult(receipt.queueItemId);
      expect(scriptExecute).toHaveBeenCalledTimes(actor === "owner" ? 1 : 0);
      expect(bashExecute).toHaveBeenCalledTimes(actor === "owner" ? 1 : 0);
      expect(gates).toEqual([]);
      if (actor !== "owner") {
        const transcript = JSON.stringify(await session.readEntries("web:default"));
        expect(transcript).toContain(actor === "scope" ? "scope" : "[not_available]");
      }
    } finally { faux.unregister(); }
  });

  it.each(["../secret", "references/../x.md", "/etc/passwd", "C:/secret", "scripts\\check.py", "./scripts/check.py", "scripts//check.py"])("rejects the path %s", async (path) => {
    const ctx = skillContext();
    expect((await buildSkillTool([fixture])!.execute({ name: fixture.name, path }, ctx)).text).toContain("[skill_bad_path]");
    expect((await buildSkillScriptTool([fixture]).execute({ name: fixture.name, script: path }, ctx)).text).toContain("[skill_bad_path]");
  });

  it("rejects unknown files, invalid UTF-8, and binary files as text", async () => {
    const tool = buildSkillTool([{ ...fixture, files: [...fixture.files!, { ...file("bad.txt", ""), bytes: new Uint8Array([255]) }] }])!;
    const ctx = skillContext();
    expect((await tool.execute({ name: fixture.name, path: "missing" }, ctx)).text).toContain("[skill_file_not_found]");
    for (const path of ["assets/data.bin", "bad.txt"]) {
      expect((await tool.execute({ name: fixture.name, path }, ctx)).text).toContain("[skill_binary_file]");
    }
    expect((await buildSkillScriptTool([fixture]).execute({ name: fixture.name, script: "references/x.md" }, ctx)).text).toContain("[skill_bad_path]");
    expect((await buildSkillScriptTool([fixture]).execute({ name: fixture.name, script: "scripts/missing.py" }, ctx)).text).toContain("[skill_file_not_found]");
  });

  it("rewrites only scripts and uses the non-local sandbox default directory", async () => {
    const ctx = skillContext();
    ctx.cwd = "/workspace/repo";
    const record = vi.fn();
    ctx.recordSkillInvocation = record;
    const exec = vi.spyOn(ctx.sandbox, "exec").mockImplementation(async (command) => {
      if (command === "pwd -P") return { stdout: "/workspace", stderr: "", exitCode: 0 };
      if (command.startsWith("chmod")) return { stdout: "", stderr: "", exitCode: 0 };
      return { stdout: "out", stderr: "err", exitCode: 7 };
    });
    const write = vi.spyOn(ctx.sandbox, "writeBinary");
    const tool = buildSkillScriptTool([fixture]);
    expect(write).not.toHaveBeenCalled();
    const args = { name: fixture.name, script: "scripts/check.py", args: ["reply.md", "a'; $(touch /bad)"] };
    const first = await tool.execute(args, ctx);
    expect(first.text).toContain('"exitCode":7');
    expect(first.text).toContain('"stdout":"out"');
    expect(first.text).toContain('"stderr":"err"');
    const files = write.mock.calls.map(([path]) => path);
    expect(files.filter((path) => path.includes("/scripts/"))).toHaveLength(2);
    expect(files.some((path) => path.includes("references/") || path.includes("assets/"))).toBe(false);
    const call = exec.mock.calls.at(-1)!;
    expect(call[0]).toContain("'python3'");
    expect(call[0]).toContain("'reply.md'");
    expect(call[0]).toContain("'a'\\''; $(touch /bad)'");
    expect(call[1]).not.toHaveProperty("cwd");
    expect(exec.mock.calls.every(([, opts]) => opts?.cwd === undefined)).toBe(true);
    expect(call[1]?.timeout).toBe(120_000);
    expect(call[1]?.env?.SKILL_DIR).toMatch(/\/check-reply@[a-f0-9]{64}$/);
    expect(record.mock.calls[0]?.[1]).toBe("script_run");
    const count = write.mock.calls.length;
    await tool.execute(args, ctx);
    expect(write).toHaveBeenCalledTimes(count + 2);
  });

  it.each([
    ["check.py", "", "python3"], ["check.sh", "", "bash"],
    ["check.js", "", "node"], ["check.mjs", "", "node"],
    ["check.sh", "#!/usr/bin/python3 -u\n", "/usr/bin/python3"],
    ["check.py", "#!/usr/bin/env python3 -u\n", "/usr/bin/env"],
    ["check", "", null],
  ])("selects the interpreter for %s with %s", async (name, body, expected) => {
    const ctx = skillContext();
    const exec = vi.spyOn(ctx.sandbox, "exec").mockImplementation(async (command) => ({
      stdout: command === "pwd -P" ? "/workspace" : "", stderr: "", exitCode: 0,
    }));
    const source = { ...fixture, files: [file(`scripts/${name}`, body)] };
    const result = await buildSkillScriptTool([source]).execute({ name: source.name, script: `scripts/${name}` }, ctx);
    expect(result.text).toContain('"exitCode":0');
    const command = exec.mock.calls.at(-1)![0];
    if (expected) expect(command.startsWith(`'${expected}' `)).toBe(true);
    else expect(command.startsWith("'/workspace/.valet/skills/")).toBe(true);
    if (body.includes("env python3 -u")) expect(command).toContain("'/usr/bin/env' 'python3' '-u'");
  });

  it("bounds stdout and stderr in the tool result", async () => {
    const ctx = skillContext();
    const exec = vi.spyOn(ctx.sandbox, "exec").mockImplementation(async (command) => ({
      stdout: command === "pwd -P" ? "/workspace" : "x".repeat(50_000),
      stderr: "y".repeat(50_000), exitCode: 0,
    }));
    const result = await buildSkillScriptTool([fixture]).execute({ name: fixture.name, script: "scripts/check.py" }, ctx);
    const output: unknown = JSON.parse(result.text ?? "{}");
    expect(output).toMatchObject({ stdout: "x".repeat(32 * 1024), stderr: "y".repeat(32 * 1024), truncated: true });
    expect(exec.mock.calls.at(-1)?.[1]?.maxOutputBytes).toBe(32 * 1024);
  });

  it("returns a clear error without a sandbox", async () => {
    const ctx = skillContext();
    Reflect.deleteProperty(ctx, "sandbox");
    const result = await buildSkillScriptTool([fixture]).execute({ name: fixture.name, script: "scripts/check.py" }, ctx);
    expect(result.text).toContain("[skill_no_sandbox]");
  });

  it("writes scripts through DockerSandbox's real working-directory path check", async () => {
    const sandbox = new DockerSandbox("docker-skill", {
      containerId: "test", workspace: "/host/session", containerWorkspace: "/workspace", image: "test",
    });
    const exec = vi.spyOn(sandbox, "exec").mockImplementation(async (command) => ({
      stdout: command === "pwd -P" ? "/workspace\n" : "checked", stderr: "", exitCode: 0,
    }));
    await expect(sandbox.mkdir("/root/.valet/skills")).rejects.toThrow("outside the working directory");
    const result = await buildSkillScriptTool([fixture]).execute({ name: fixture.name, script: "scripts/check.py" }, skillContext(sandbox));
    expect(result.text).toContain('"exitCode":0');
    expect(result.text).toContain("/workspace/.valet/skills/");
    expect(exec.mock.calls.some(([command]) => command.startsWith("base64 -d > '/workspace/.valet/skills/"))).toBe(true);
    expect(exec.mock.calls.some(([command]) => command.includes("/root/"))).toBe(false);
  });

  it("publishes complete script files while another call is still writing", async () => {
    const root = await mkdtemp(join(tmpdir(), "skill-race-"));
    let allowFirst!: () => void;
    let firstReady!: () => void;
    let allowSecond!: () => void;
    let secondTruncated!: () => void;
    const firstAtExec = new Promise<void>(resolve => { firstReady = resolve; });
    const firstMayExec = new Promise<void>(resolve => { allowFirst = resolve; });
    const secondAtWrite = new Promise<void>(resolve => { secondTruncated = resolve; });
    const secondMayWrite = new Promise<void>(resolve => { allowSecond = resolve; });
    try {
      const sandbox = new LocalSandbox("race", root);
      const exec = sandbox.exec.bind(sandbox);
      let executions = 0;
      vi.spyOn(sandbox, "exec").mockImplementation(async (command, opts) => {
        if (command.startsWith("'python3'") && executions++ === 0) {
          firstReady();
          await firstMayExec;
        }
        return exec(command, opts);
      });
      const write = sandbox.writeBinary.bind(sandbox);
      let writes = 0;
      const writing = vi.spyOn(sandbox, "writeBinary").mockImplementation(async (path, bytes) => {
        if (++writes === 2) {
          await write(path, new Uint8Array());
          secondTruncated();
          await secondMayWrite;
        }
        await write(path, bytes);
      });
      const source = { ...fixture, files: [file("scripts/race.py", "print('checked')")] };
      const args = { name: source.name, script: "scripts/race.py" };
      const tool = buildSkillScriptTool([source]);
      const first = tool.execute(args, skillContext(sandbox));
      await firstAtExec;
      const second = tool.execute(args, skillContext(sandbox));
      await secondAtWrite;
      allowFirst();
      const result = await first;
      expect(result.text).toContain('"exitCode":0');
      expect(result.text).toContain("checked");
      allowSecond();
      expect((await second).text).toContain("checked");
      const paths = writing.mock.calls.map(([path]) => path);
      expect(new Set(paths).size).toBe(2);
      expect(paths.every(path => path.includes(".tmp-"))).toBe(true);
    } finally {
      allowFirst(); allowSecond();
      await rm(root, { recursive: true, force: true });
    }
  });

  it("runs a shebang script in a local sandbox with literal arguments and executable bits", async () => {
    const root = await mkdtemp(join(tmpdir(), "skill-files-"));
    try {
      const sandbox = new LocalSandbox("local-skill", root);
      const originalExec = sandbox.exec.bind(sandbox);
      vi.spyOn(sandbox, "exec").mockImplementation((command, opts) => originalExec(command, {
        ...opts, env: { ...opts?.env, HOME: root },
      }));
      const ctx = { ...skillContext(), sandbox, cwd: root };
      await sandbox.writeFile("reply.md", "hello");
      const source = { ...fixture, files: [fixture.files![0]!, file("scripts/check.py", `#!/usr/bin/env python3 -u
import os, sys
print(open(sys.argv[1]).read())
print(os.environ['SKILL_DIR'])
print(sys.argv[2])
print('diagnostic', file=sys.stderr)
sys.exit(3)
`, "100755")] };
      const write = vi.spyOn(sandbox, "writeBinary");
      const tool = buildSkillScriptTool([source]);
      const args = { name: source.name, script: "scripts/check.py", args: ["reply.md", "$(touch injected);'"] };
      const result = await tool.execute(args, ctx);
      expect(result.text).toContain('"exitCode":3');
      expect(result.text).toContain("hello");
      expect(result.text).toContain("diagnostic");
      expect(result.text).toContain("$(touch injected);'");
      const path = write.mock.calls[0]![0].split(".tmp-")[0]!;
      expect((await stat(path)).mode & 0o777).toBe(0o755);
      await expect(stat(join(root, "injected"))).rejects.toThrow();
      await sandbox.writeFile(path, "print('tampered')");
      const again = await tool.execute({ ...args, timeout: 13 }, ctx);
      expect(again.text).toContain("hello");
      expect(again.text).not.toContain("tampered");
      expect(write).toHaveBeenCalledTimes(2);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
