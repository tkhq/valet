import { fauxAssistantMessage, fauxToolCall, registerFauxProvider } from "@earendil-works/pi-ai/compat";
import { KubernetesSandbox, buildSandboxManifest, SANDBOX_CR_API_VERSION } from "@valet/sandbox-kubernetes";
import { EventEmitter } from "node:events";
import { DockerSandbox } from "@valet/sandbox-docker";
import { tmpdir } from "node:os";
import { mkdtemp, rm, stat, readdir, writeFile } from "node:fs/promises";
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

function referenceText(text: string): string { return text.split("\n\n[total_bytes=")[0]!; }
function scriptPath(text: string): string {
  const value: unknown = JSON.parse(text);
  if (!value || typeof value !== "object" || !("path" in value) || typeof value.path !== "string") throw new Error("Missing script path");
  return value.path;
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
    expect(referenceText((await tool.execute({ name: fixture.name, path: "references/x.md" }, ctx)).text)).toBe("Reference text.");
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
    expect(referenceText((await tool.execute({ name: source.name, path: "references/examples.md" }, skillContext())).text)).toBe(reference);
    expect(referenceText((await tool.execute({ name: source.name, path: "references/large.md" }, skillContext())).text)).toBe("a".repeat(65_536));
    expect(referenceText((await tool.execute({ name: source.name, path: "references/large.md", offset: 65_536 }, skillContext())).text)).toBe("b".repeat(20_000));
    expect(referenceText((await tool.execute({ name: source.name, path: "references/large.md", offset: 65_536, limit: 300 }, skillContext())).text)).toBe("b".repeat(300));
    expect(referenceText((await tool.execute({ name: source.name, path: "references/large.md", offset: 100_000 }, skillContext())).text)).toBe("");
    expect((await tool.execute({ name: source.name, offset: 0 }, skillContext())).text).toContain("[skill_bad_range]");
  });

  it("keeps pages valid UTF-8 and rejects offsets inside a character", async () => {
    const source = { ...fixture, files: [file("references/x.md", "aé🙂z")] };
    const tool = buildSkillTool([source])!;
    const args = { name: source.name, path: "references/x.md" };
    expect(referenceText((await tool.execute({ ...args, limit: 2 }, skillContext())).text)).toBe("a");
    expect(referenceText((await tool.execute({ ...args, offset: 1, limit: 2 }, skillContext())).text)).toBe("é");
    expect(referenceText((await tool.execute({ ...args, offset: 3, limit: 4 }, skillContext())).text)).toBe("🙂");
    expect((await tool.execute({ ...args, offset: 2 }, skillContext())).text).toContain("[skill_bad_range]");
    expect((await tool.execute({ ...args, offset: 3, limit: 1 }, skillContext())).text).toContain("[skill_bad_range]");
  });

  it("reports total bytes, the next offset, and end-of-file", async () => {
    const tool = buildSkillTool([fixture])!;
    const args = { name: fixture.name, path: "references/x.md" };
    expect((await tool.execute({ ...args, limit: 4 }, skillContext())).text).toBe("Refe\n\n[total_bytes=15 next_offset=4 end=false]");
    expect((await tool.execute({ ...args, offset: 4 }, skillContext())).text).toContain("total_bytes=15 next_offset=15 end=true");
  });

  it("names body rendering errors separately from file read failures", async () => {
    const broken = { ...fixture, get content(): string { throw new Error("render failed"); } };
    expect((await buildSkillTool([broken])!.execute({ name: broken.name }, skillContext())).text).toContain("[skill_body_unavailable]");
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

  it("publishes all stored scripts in two execs and never uses provider file APIs or host cwd", async () => {
    const ctx = skillContext();
    ctx.cwd = "/workspace/repo";
    const record = vi.fn(); ctx.recordSkillInvocation = record;
    const exec = vi.spyOn(ctx.sandbox, "exec").mockImplementation(async command => {
      if (command === "sh -s") return { stdout: "/cache/valet/skills/check-reply@sha", stderr: "", exitCode: 0 };
      return { stdout: "out", stderr: "err", exitCode: 7 };
    });
    const write = vi.spyOn(ctx.sandbox, "writeBinary");
    const mkdir = vi.spyOn(ctx.sandbox, "mkdir");
    const tool = buildSkillScriptTool([fixture]);
    const args = { name: fixture.name, script: "scripts/check.py", args: ["reply.md", "a'; $(touch /bad)"], timeout: 12 };
    expect((await tool.execute(args, ctx)).text).toContain('"exitCode":7');
    expect(exec).toHaveBeenCalledTimes(3); // publication, cleanup, execution
    const payload = exec.mock.calls[0]![1]?.stdin ?? "";
    expect(payload).toContain("scripts/check.py"); expect(payload).toContain("scripts/lib/util.py");
    expect(payload).not.toContain("references/"); expect(payload).not.toContain("assets/");
    expect(payload).toContain("base64 -d"); expect(payload).toContain("mv -f");
    expect(write).not.toHaveBeenCalled(); expect(mkdir).not.toHaveBeenCalled();
    const call = exec.mock.calls.at(-1)!;
    expect(call[0]).toContain("'python3'"); expect(call[0]).toContain("'reply.md'");
    expect(call[0]).toContain("'a'\\''; $(touch /bad)'");
    expect(exec.mock.calls.every(([, opts]) => opts?.cwd === undefined)).toBe(true);
    expect(call[1]?.timeout).toBe(12_000);
    expect(record.mock.calls[0]?.[1]).toBe("script_run");
    await tool.execute(args, ctx);
    expect(exec).toHaveBeenCalledTimes(6);
  });

  it("publication round trips are constant for 64 scripts", async () => {
    const ctx = skillContext();
    const exec = vi.spyOn(ctx.sandbox, "exec").mockImplementation(async command => ({ stdout: command === "sh -s" ? "/cache/valet/skills/x@sha" : "", stderr: "", exitCode: 0 }));
    const source = { ...fixture, files: Array.from({ length: 64 }, (_, i) => file(`scripts/${i}.sh`, "echo checked")) };
    await buildSkillScriptTool([source]).execute({ name: source.name, script: "scripts/0.sh", timeout: 1 }, ctx);
    expect(exec).toHaveBeenCalledTimes(3);
  });

  it.each([
    ["check.py", "", "python3"], ["check.sh", "", "bash"],
    ["check.js", "", "node"], ["check.mjs", "", "node"],
    ["check.sh", "#!/usr/bin/python3 -u\n", "/usr/bin/python3"],
    ["check.py", "#!/usr/bin/env python3 -u\n", "/usr/bin/env"],
    ["check", "", null],
    ["check.py", "#!\nprint(1)", "python3"],
    ["check.py", "\ufeff#!/usr/bin/env python3 -u\nprint(1)", "/usr/bin/env"],
  ])("selects the interpreter for %s with %s", async (name, body, expected) => {
    const ctx = skillContext();
    const exec = vi.spyOn(ctx.sandbox, "exec").mockImplementation(async (command) => ({
      stdout: command === "sh -s" ? "/cache/valet/skills/x@sha" : "", stderr: "", exitCode: 0,
    }));
    const source = { ...fixture, files: [file(`scripts/${name}`, body)] };
    const result = await buildSkillScriptTool([source]).execute({ name: source.name, script: `scripts/${name}` }, ctx);
    expect(result.text).toContain('"exitCode":0');
    const command = exec.mock.calls.at(-1)![0];
    if (expected) expect(command.startsWith(`'${expected}' `)).toBe(true);
    else expect(command.startsWith("'/cache/valet/skills/")).toBe(true);
    if (body.includes("env python3 -u")) expect(command).toContain("'/usr/bin/env' 'python3' '-u'");
  });

  it("bounds stdout and stderr in the tool result", async () => {
    const ctx = skillContext();
    const exec = vi.spyOn(ctx.sandbox, "exec").mockImplementation(async (command) => ({
      stdout: command === "sh -s" ? "/cache/valet/skills/x@sha" : "x".repeat(50_000),
      stderr: "y".repeat(50_000), exitCode: 0,
    }));
    const result = await buildSkillScriptTool([fixture]).execute({ name: fixture.name, script: "scripts/check.py", timeout: 1 }, ctx);
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

  it("bypasses Docker file-API restrictions with exec-only external-cache publication", async () => {
    const sandbox = new DockerSandbox("docker-skill", { containerId: "test", workspace: "/host/session", containerWorkspace: "/workspace", image: "test" });
    const exec = vi.spyOn(sandbox, "exec").mockImplementation(async command => ({
      stdout: command === "sh -s" ? "/root/.cache/valet/skills/check-reply@sha" : "checked", stderr: "", exitCode: 0,
    }));
    await expect(sandbox.mkdir("/root/.cache/valet/skills")).rejects.toThrow("outside the working directory");
    const write = vi.spyOn(sandbox, "writeBinary");
    const result = await buildSkillScriptTool([fixture]).execute({ name: fixture.name, script: "scripts/check.py", timeout: 1 }, skillContext(sandbox));
    expect(result.text).toContain('"exitCode":0'); expect(result.text).toContain("/root/.cache/valet/skills/");
    expect(write).not.toHaveBeenCalled(); expect(exec).toHaveBeenCalledTimes(3);
  });

  it("publishes through the Kubernetes exec transport with one stdin payload", async () => {
    const commands: string[][] = [];
    const inputs: string[] = [];
    const cfg = { namespace: "test", defaultImage: "test", apiVersion: SANDBOX_CR_API_VERSION };
    const manifest = buildSandboxManifest(cfg, "k8s-skill", { sessionId: "session" });
    manifest.metadata.annotations = { "agents.x-k8s.io/pod-name": "pod" };
    const sandbox = new KubernetesSandbox({
      cfg,
      objectsApi: {
        getNamespacedCustomObject: async () => manifest,
        listNamespacedCustomObject: vi.fn(), createNamespacedCustomObject: vi.fn(), replaceNamespacedCustomObject: vi.fn(),
        patchNamespacedCustomObject: vi.fn(), deleteNamespacedCustomObject: vi.fn(),
      },
      podsApi: { listNamespacedPod: async () => ({ items: [] }), patchNamespacedPod: vi.fn() },
      livenessApi: { getPodUid: async () => "uid" },
      execApi: { exec: async (_ns, _pod, _container, command, stdout, _stderr, stdin, _tty, callback) => {
        commands.push(command);
        // Kubernetes frames stdin by length; the stream deliberately does not end.
        if (stdin) inputs.push(String(stdin.read() ?? ""));
        stdout?.write(commands.length === 1 ? "/home/agent/.cache/valet/skills/check-reply@sha" : "");
        queueMicrotask(() => callback?.({ status: "Success" }));
        return Object.assign(new EventEmitter(), { close: vi.fn(), readyState: 1, bufferedAmount: 0 });
      } },
    }, "k8s-skill");
    const write = vi.spyOn(sandbox, "writeBinary");
    const result = await buildSkillScriptTool([fixture]).execute({ name: fixture.name, script: "scripts/check.py", timeout: 1 }, skillContext(sandbox));
    expect(result.text).toContain('"exitCode":0');
    expect(result.text).toContain("/home/agent/.cache/valet/skills/");
    expect(commands).toHaveLength(3); expect(write).not.toHaveBeenCalled();
    expect(inputs).toHaveLength(1); expect(inputs[0]).toContain("base64 -d"); expect(inputs[0]).toContain("scripts/check.py");
  });

  it("publishes complete script files while another call is still writing", async () => {
    const root = await mkdtemp(join(tmpdir(), "skill-race-"));
    let allowFirst!: () => void; let firstReady!: () => void;
    let secondReady!: () => void; let allowSecond!: () => void;
    const atStage = new Promise<void>(resolve => { secondReady = resolve; });
    const mayPublish = new Promise<void>(resolve => { allowSecond = resolve; });
    const atExec = new Promise<void>(resolve => { firstReady = resolve; });
    const mayExec = new Promise<void>(resolve => { allowFirst = resolve; });
    try {
      const sandbox = new LocalSandbox("race", root);
      const exec = sandbox.exec.bind(sandbox);
      let executions = 0; let publications = 0;
      vi.spyOn(sandbox, "exec").mockImplementation(async (command, opts) => {
        if (command.startsWith("'python3'") && executions++ === 0) { firstReady(); await mayExec; }
        const env = { ...opts?.env, HOME: root, XDG_CACHE_HOME: "" };
        if (command === "sh -s" && ++publications === 2) {
          const setup = opts?.stdin ?? "";
          const partial = setup.slice(0, setup.indexOf("mv -f")).replace(/trap '[^\n]+\n/, "") + 'printf "" > "$stage/scripts/race.py"';
          await exec("sh -s", { stdin: partial, env });
          secondReady(); await mayPublish;
        }
        return exec(command, { ...opts, env });
      });
      const source = { ...fixture, files: [file("scripts/race.py", "print('checked')")] };
      const args = { name: source.name, script: "scripts/race.py", timeout: 1 };
      const tool = buildSkillScriptTool([source]);
      const first = tool.execute(args, skillContext(sandbox));
      await atExec;
      const second = tool.execute(args, skillContext(sandbox));
      await atStage; allowFirst();
      expect((await first).text).toContain("checked");
      allowSecond(); expect((await second).text).toContain("checked");
      expect((await readdir(join(root, ".cache/valet/skills"))).some(name => name.startsWith(".tmp-"))).toBe(false);
    } finally { allowFirst(); allowSecond(); await rm(root, { recursive: true, force: true }); }
  });

  it.each(["timeout", "abort", "stuck-poll"])("cancels remote script jobs on %s", async cause => {
    vi.useFakeTimers();
    try {
      const ctx = skillContext(); const abort = new AbortController(); ctx.signal = abort.signal;
      vi.spyOn(ctx.sandbox, "exec").mockImplementation(async command => ({ stdout: command === "sh -s" ? "/cache/valet/skills/x@sha" : "", stderr: "", exitCode: 0 }));
      const kickoff = vi.spyOn(ctx.sandbox, "execJob").mockResolvedValue({ execId: "job" });
      vi.spyOn(ctx.sandbox, "pollJob").mockImplementation(() => cause === "stuck-poll"
        ? new Promise(() => {}) : Promise.resolve({ status: "running", output: "", nextOffset: 0 }));
      const cancel = vi.spyOn(ctx.sandbox, "cancelJob").mockResolvedValue();
      const result = buildSkillScriptTool([fixture]).execute({ name: fixture.name, script: "scripts/check.py", timeout: 61 }, ctx);
      await vi.advanceTimersByTimeAsync(10);
      expect(kickoff).toHaveBeenCalledTimes(1);
      if (cause === "abort") abort.abort(new Error("stopped"));
      await vi.advanceTimersByTimeAsync(cause !== "abort" ? 64_000 : 200);
      const output = await result;
      expect(cancel).toHaveBeenCalledWith("job");
      expect(output.text).toContain(cause !== "abort" ? '"timedOut":true' : "stopped");
    } finally { vi.useRealTimers(); }
  });

  it.each(["chmod", "mv", "abort"])("cleans the publication stage on %s failure", async failure => {
    const root = await mkdtemp(join(tmpdir(), "skill-cleanup-"));
    try {
      const sandbox = new LocalSandbox("cleanup", root); const exec = sandbox.exec.bind(sandbox);
      const ctx = skillContext(sandbox); const controller = new AbortController(); ctx.signal = controller.signal;
      vi.spyOn(sandbox, "exec").mockImplementation(async (command, opts) => {
        let stdin = opts?.stdin;
        const env = { ...opts?.env, HOME: root, XDG_CACHE_HOME: "" };
        if (command === "sh -s") {
          if (failure === "abort") {
            // Simulate a provider abort after staging, before the remote trap ran.
            const staged = stdin!.slice(0, stdin!.indexOf("trap '")) + 'mkdir -p -- "$stage"';
            await exec(staged, { env }); controller.abort(); throw new Error("aborted");
          }
          stdin = stdin!.replace(failure === "chmod" ? "chmod 755" : "mv -f", "false");
        }
        return exec(command, { ...opts, env, stdin });
      });
      expect((await buildSkillScriptTool([fixture]).execute({ name: fixture.name, script: "scripts/check.py", timeout: 1 }, ctx)).text).toContain("[skill_script_failed]");
      expect((await readdir(join(root, ".cache/valet/skills"))).some(name => name.startsWith(".tmp-"))).toBe(false);
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it.each(["xdg", "unwritable-home"])("uses an external cache with %s", async mode => {
    const root = await mkdtemp(join(tmpdir(), "skill-cache-"));
    let path: string | undefined;
    try {
      const sandbox = new LocalSandbox("cache", root); const exec = sandbox.exec.bind(sandbox);
      vi.spyOn(sandbox, "exec").mockImplementation((command, opts) => exec(command, { ...opts, env: { ...opts?.env,
        HOME: mode === "unwritable-home" ? "/proc/valet-unwritable" : root, XDG_CACHE_HOME: mode === "xdg" ? join(root, "external") : "" } }));
      const source = { ...fixture, name: `cache-${Date.now()}`, files: [file("scripts/check.py", "print('checked')")] };
      const output = await buildSkillScriptTool([source]).execute({ name: source.name, script: "scripts/check.py", timeout: 1 }, skillContext(sandbox));
      path = scriptPath(output.text);
      expect(path).toContain(mode === "xdg" ? `${root}/external/valet/skills/` : "/tmp/valet-skills/");
      await expect(stat(join(root, ".valet"))).rejects.toThrow();
    } finally { if (path?.startsWith("/tmp/valet-skills/")) await rm(join(path, "../.."), { recursive: true, force: true }); await rm(root, { recursive: true, force: true }); }
  });

  it("runs a shebang script in a local sandbox with literal arguments and executable bits", async () => {
    const root = await mkdtemp(join(tmpdir(), "skill-files-"));
    try {
      const sandbox = new LocalSandbox("local-skill", root);
      const originalExec = sandbox.exec.bind(sandbox);
      vi.spyOn(sandbox, "exec").mockImplementation((command, opts) => originalExec(command, {
        ...opts, env: { ...opts?.env, HOME: root, XDG_CACHE_HOME: "" },
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
      const path = scriptPath(result.text);
      expect((await stat(path)).mode & 0o777).toBe(0o755);
      await expect(stat(join(root, "injected"))).rejects.toThrow();
      await writeFile(path, "print('tampered')");
      const again = await tool.execute({ ...args, timeout: 13 }, ctx);
      expect(again.text).toContain("hello");
      expect(again.text).not.toContain("tampered");
      expect(write).not.toHaveBeenCalled();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
