import { tmpdir } from "node:os";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { bashTool, VirtualSandbox, type SkillFile, type SkillSource, type ToolContext } from "@valet/engine";
import { LocalSandbox } from "@valet/sandbox-local";
import { buildSkillTool } from "./skill-tool.js";
import { buildSkillScriptTool } from "./skill-script-tool.js";

function skillContext(sandbox = new VirtualSandbox("test")): ToolContext {
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
  it("lists stored files without writing them and protects reference reads", async () => {
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

  it("writes only scripts on call, reuses the sha, and passes execution context", async () => {
    const ctx = skillContext();
    ctx.cwd = "/workspace/repo";
    const record = vi.fn();
    ctx.recordSkillInvocation = record;
    let ready = false;
    const exec = vi.spyOn(ctx.sandbox, "exec").mockImplementation(async (command) => {
      if (command.startsWith("printf")) return { stdout: "/home/agent", stderr: "", exitCode: 0 };
      if (command.startsWith("test")) return { stdout: "", stderr: "", exitCode: ready ? 0 : 1 };
      if (command.startsWith("chmod")) return { stdout: "", stderr: "", exitCode: 0 };
      return { stdout: "out", stderr: "err", exitCode: 7 };
    });
    const write = vi.spyOn(ctx.sandbox, "writeBinary");
    const tool = buildSkillScriptTool([fixture]);
    expect(tool.riskLevel).toBe(bashTool.riskLevel);
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
    expect(call[1]?.cwd).toBe(ctx.cwd);
    expect(call[1]?.env?.SKILL_DIR).toMatch(/\/check-reply@[a-f0-9]{64}$/);
    expect(record.mock.calls[0]?.[1]).toBe("script_run");
    ready = true;
    const count = write.mock.calls.length;
    await tool.execute(args, ctx);
    expect(write).toHaveBeenCalledTimes(count);
  });

  it.each([
    ["check.py", "", "python3"], ["check.sh", "", "bash"],
    ["check.js", "", "node"], ["check.mjs", "", "node"],
    ["check.sh", "#!/usr/bin/python3 -u\n", "/usr/bin/python3"],
    ["check", "", null],
  ])("selects the interpreter for %s with %s", async (name, body, expected) => {
    const ctx = skillContext();
    const exec = vi.spyOn(ctx.sandbox, "exec").mockImplementation(async (command) => ({
      stdout: command.startsWith("printf") ? "/home/agent" : "", stderr: "", exitCode: 0,
    }));
    const source = { ...fixture, files: [file(`scripts/${name}`, body)] };
    const result = await buildSkillScriptTool([source]).execute({ name: source.name, script: `scripts/${name}` }, ctx);
    expect(result.text).toContain('"exitCode":0');
    const command = exec.mock.calls.at(-1)![0];
    if (expected) expect(command.startsWith(`'${expected}' `)).toBe(true);
    else expect(command.startsWith("'/home/agent/.valet/skills/")).toBe(true);
  });

  it("bounds stdout and stderr in the tool result", async () => {
    const ctx = skillContext();
    const exec = vi.spyOn(ctx.sandbox, "exec").mockImplementation(async (command) => ({
      stdout: command.startsWith("printf") ? "/home/agent" : "x".repeat(50_000),
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
      const source = { ...fixture, files: [fixture.files![0]!, file("scripts/check.py", `#!/usr/bin/env python3
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
      const path = write.mock.calls[0]![0];
      expect((await stat(path)).mode & 0o777).toBe(0o755);
      await expect(stat(join(root, "injected"))).rejects.toThrow();
      await tool.execute(args, ctx);
      expect(write).toHaveBeenCalledTimes(1);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
