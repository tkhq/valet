/**
 * The `read` tool returns a source for the file: a GitHub link at HEAD when
 * GitHub has the commit and the file matches it, else the line range,
 * commit, and sandbox path in the location.
 */
import { describe, expect, it } from "vitest";
import { readTool } from "../src/builtin-tools/index.js";
import { fileSource, githubRepo, readFileOrigin } from "../src/builtin-tools/file-source.js";
import type { ExecOpts, ExecResult, Sandbox, ToolContext } from "../src/types.js";

const SHA = "3f2a1c9d".padEnd(40, "0");
const TEXT = "export const a = 1;\nexport const b = 2;\n";

function sandbox(exec: (command: string, opts?: ExecOpts) => Promise<ExecResult>): Sandbox {
  const unused = async (): Promise<never> => { throw new Error("unused"); };
  return {
    id: "sb", readFile: async () => TEXT, readBinary: unused, writeFile: unused, writeBinary: unused, readdir: unused,
    stat: unused, mkdir: unused, rm: unused, exec,
  };
}

function gitAnswer(lines: string[]): (command: string, opts?: ExecOpts) => Promise<ExecResult> {
  return async () => ({ exitCode: 0, stdout: `${lines.join("\n")}\n`, stderr: "" });
}

function ctx(box: Sandbox): ToolContext {
  return {
    userId: "u", orgId: "o", sessionId: "s", threadId: "t", cwd: "/workspace/app",
    credentials: { get: async () => null, request: async () => { throw new Error("unused"); } },
    sandbox: box,
    requestDecision: async () => { throw new Error("unused"); },
    signal: new AbortController().signal,
    threadRead: async () => [],
    listThreads: async () => [],
    setModel: async ({ model }) => ({ fromModel: model, toModel: model }),
  };
}

describe("read tool sources", () => {
  it("links a clean file to GitHub at the pushed HEAD with the lines read", async () => {
    const commands: string[] = [];
    const box = sandbox(async (command, opts) => {
      commands.push(command);
      expect(opts?.timeout).toBeGreaterThan(0);
      return gitAnswer(["/workspace/app", SHA, "https://x-access-token:secret@github.com/acme/app.git", "clean", "pushed"])(command);
    });
    const result = await readTool.execute({ path: "src/a b.ts" }, ctx(box));
    expect(result.text).toBe(TEXT);
    expect(result.sources).toEqual([{
      service: "github",
      title: "acme/app/src/a b.ts",
      url: `https://github.com/acme/app/blob/${SHA}/src/a%20b.ts#L1-L2`,
      snippet: TEXT,
      location: "L1-L2 at 3f2a1c9",
    }]);
    expect(commands).toHaveLength(1);
    expect(commands[0]).toContain("cd '/workspace/app/src'");
    expect(commands[0]).toContain("'/workspace/app/src/a b.ts'");
    expect(JSON.stringify(result.sources)).not.toContain("secret");
  });

  it("keeps the commit in the location and gives no link when the file changed or HEAD is not pushed", async () => {
    for (const [state, pushed] of [["changed", "pushed"], ["clean", ""]]) {
      const box = sandbox(gitAnswer(["/workspace/app", SHA, "git@github.com:acme/app.git", state!, pushed!]));
      const [source] = (await readTool.execute({ path: "/workspace/app/src/a.ts" }, ctx(box))).sources ?? [];
      expect(source).toEqual({
        service: "sandbox",
        title: "acme/app/src/a.ts",
        snippet: TEXT,
        location: "L1-L2 at 3f2a1c9, /workspace/app/src/a.ts",
      });
    }
  });

  it("names the repo folder when the remote is not GitHub, and the path alone outside a repo", async () => {
    const gitlab = sandbox(gitAnswer(["/workspace/app", SHA, "https://gitlab.com/acme/app.git", "clean", "pushed"]));
    const [inRepo] = (await readTool.execute({ path: "README.md" }, ctx(gitlab))).sources ?? [];
    expect(inRepo).toMatchObject({ service: "sandbox", title: "app/README.md", location: "L1-L2 at 3f2a1c9, /workspace/app/README.md" });
    expect(inRepo?.url).toBeUndefined();
    const noGit = sandbox(async () => ({ exitCode: 128, stdout: "", stderr: "not a git repository" }));
    const [outside] = (await readTool.execute({ path: "/tmp/notes.txt" }, ctx(noGit))).sources ?? [];
    expect(outside).toEqual({ service: "sandbox", title: "/tmp/notes.txt", snippet: TEXT, location: "L1-L2" });
  });

  it("still reads the file when git throws", async () => {
    const box = sandbox(async () => { throw new Error("exec unavailable"); });
    const result = await readTool.execute({ path: "/tmp/x" }, ctx(box));
    expect(result.text).toBe(TEXT);
    expect(result.sources?.[0]).toMatchObject({ service: "sandbox", title: "/tmp/x" });
  });
});

describe("file source helpers", () => {
  it("reads owner and repo from every github.com remote form", () => {
    for (const remote of ["https://github.com/acme/app", "https://github.com/acme/app.git", "git@github.com:acme/app.git",
      "ssh://git@github.com/acme/app.git", "https://token@github.com/acme/app.git/"]) {
      expect(githubRepo(remote), remote).toBe("acme/app");
    }
    expect(githubRepo("https://github.example.com/acme/app.git")).toBeUndefined();
    expect(githubRepo("https://evilgithub.com/acme/app")).toBeUndefined();
  });

  it("rejects a git answer that is not a root and a commit", async () => {
    expect(await readFileOrigin(sandbox(gitAnswer(["relative", SHA, "", "clean", ""])), "/a/b")).toBeUndefined();
    expect(await readFileOrigin(sandbox(gitAnswer(["/a", "HEAD", "", "clean", ""])), "/a/b")).toBeUndefined();
  });

  it("numbers lines from the first line read", () => {
    const origin = { root: "/r", sha: SHA, github: "acme/app", clean: true, pushed: true };
    expect(fileSource("/r/a.ts", "x\ny\n", origin, 10)).toMatchObject({ url: `https://github.com/acme/app/blob/${SHA}/a.ts#L10-L11`, location: "L10-L11 at 3f2a1c9" });
  });

  it("gives an empty file no line range", () => {
    expect(fileSource("/tmp/empty", "", undefined)).toEqual({ service: "sandbox", title: "/tmp/empty" });
  });
});
