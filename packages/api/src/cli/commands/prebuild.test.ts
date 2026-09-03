/**
 * `valet prebuild` unit coverage — the pure `runPrebuild` against injected
 * deps and a real temp dir (the recipe file is read from the working tree by
 * design, so the tests exercise real fs reads). No git or docker binaries
 * are invoked: `capture` fakes `git ls-tree`, `stream` fakes `git archive`
 * and `docker build`.
 */
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";
import { ExitCode } from "../exit.js";
import { defaultImageTag, runPrebuild, type ExecOutcome, type PrebuildDeps } from "./prebuild.js";

let outSpy: MockInstance;
let errSpy: MockInstance;
let repoDir: string;
beforeEach(async () => {
  outSpy = vi.spyOn(process.stdout, "write").mockReturnValue(true);
  errSpy = vi.spyOn(process.stderr, "write").mockReturnValue(true);
  repoDir = await mkdtemp(join(tmpdir(), "valet-prebuild-test-"));
});
afterEach(async () => {
  vi.restoreAllMocks();
  await rm(repoDir, { recursive: true, force: true });
});
const stdout = (): string => outSpy.mock.calls.map((c) => String(c[0])).join("");
const stderr = (): string => errSpy.mock.calls.map((c) => String(c[0])).join("");

interface StreamCall {
  cmd: string;
  args: string[];
  cwd: string;
  env?: NodeJS.ProcessEnv;
}

/** Deps whose git surface reports `rootFiles` at HEAD and whose stream calls
 * (git archive, docker build) succeed while being recorded. `onDocker` runs
 * inside the fake docker call, while the temp context still exists. */
function fakeDeps(opts: {
  rootFiles?: string[];
  dockerUp?: boolean;
  onDocker?: (call: StreamCall) => Promise<void> | void;
}): PrebuildDeps & { streams: StreamCall[] } {
  const streams: StreamCall[] = [];
  return {
    streams,
    probeDocker: async () => opts.dockerUp ?? true,
    capture: async (_cmd: string, args: string[]): Promise<ExecOutcome> => {
      if (args[0] === "ls-tree") {
        if (opts.rootFiles === undefined) return { code: 128, stdout: "" };
        return { code: 0, stdout: `${opts.rootFiles.join("\n")}\n` };
      }
      return { code: 0, stdout: "" };
    },
    stream: async (cmd, args, o) => {
      const call = { cmd, args, cwd: o.cwd, env: o.env };
      streams.push(call);
      if (cmd === "docker" && opts.onDocker) await opts.onDocker(call);
      return 0;
    },
  };
}

async function writeRecipe(yaml: string): Promise<void> {
  await mkdir(join(repoDir, ".valet"), { recursive: true });
  await writeFile(join(repoDir, ".valet", "prebuild.yaml"), yaml);
}

describe("runPrebuild plan", () => {
  it("prints the resolved recipe: detected steps, setup, docker, workspaceStorage", async () => {
    await writeRecipe('docker: true\nworkspaceStorage: "4Gi"\nsetup:\n  - make bootstrap\n');
    const code = await runPrebuild(["plan", repoDir], fakeDeps({ rootFiles: ["pnpm-lock.yaml", "README.md"] }));
    expect(code).toBe(ExitCode.OK);
    const out = stdout();
    expect(out).toContain("workspaceStorage: 4Gi");
    expect(out).toContain("docker:           true");
    expect(out).toContain("[pnpm-install] pnpm install --frozen-lockfile");
    expect(out).toContain("make bootstrap");
  });

  it("--json emits a machine-readable plan", async () => {
    await writeRecipe('workspaceStorage: "4Gi"\nskipDetect: true\nsetup:\n  - echo hi\n');
    const code = await runPrebuild(["plan", repoDir, "--json"], fakeDeps({ rootFiles: ["pnpm-lock.yaml"] }));
    expect(code).toBe(ExitCode.OK);
    const parsed = JSON.parse(stdout()) as {
      workspaceStorage: string;
      skipDetect: boolean;
      recipeSteps: unknown[];
      setup: string[];
    };
    expect(parsed.workspaceStorage).toBe("4Gi");
    expect(parsed.skipDetect).toBe(true);
    // skipDetect suppresses detection in the resolved recipe.
    expect(parsed.recipeSteps).toEqual([]);
    expect(parsed.setup).toEqual(["echo hi"]);
  });

  it("--dockerfile prints the local-build Dockerfile (COPY, never a token clone)", async () => {
    await writeRecipe("setup:\n  - echo hi\n");
    const code = await runPrebuild(["plan", repoDir, "--dockerfile"], fakeDeps({ rootFiles: [] }));
    expect(code).toBe(ExitCode.OK);
    const out = stdout();
    expect(out).toContain("COPY . /prebuilt/repo");
    expect(out).not.toContain("git-token");
  });

  it("an invalid recipe fails loudly with the schema error (the point of the command)", async () => {
    await writeRecipe("workspaceStorage: 4\n");
    const code = await runPrebuild(["plan", repoDir], fakeDeps({ rootFiles: [] }));
    expect(code).toBe(1);
    expect(stderr()).toContain("workspaceStorage must be a quantity string");
  });

  it("a non-git path fails with the corrective action", async () => {
    const code = await runPrebuild(["plan", repoDir], fakeDeps({ rootFiles: undefined }));
    expect(code).toBe(ExitCode.Usage);
    expect(stderr()).toContain("not a git repository");
  });

  it("no/unknown subcommand prints usage", async () => {
    expect(await runPrebuild([], fakeDeps({ rootFiles: [] }))).toBe(ExitCode.Usage);
    expect(await runPrebuild(["bogus"], fakeDeps({ rootFiles: [] }))).toBe(ExitCode.Usage);
    expect(stderr()).toContain("valet prebuild <plan|build>");
  });
});

describe("runPrebuild build", () => {
  it("refuses without a docker daemon, naming the fix", async () => {
    await writeRecipe("setup:\n  - echo hi\n");
    const code = await runPrebuild(["build", repoDir], fakeDeps({ rootFiles: [], dockerUp: false }));
    expect(code).toBe(1);
    expect(stderr()).toContain("Start Docker");
  });

  it("clones HEAD locally, overlays the working-tree recipe into the context, and streams docker build", async () => {
    await writeRecipe('workspaceStorage: "4Gi"\nsetup:\n  - echo hi\n');
    let contextRecipe: string | null = null;
    let dockerfileText: string | null = null;
    const deps = fakeDeps({
      rootFiles: ["README.md"],
      onDocker: async (call) => {
        // Inspect the temp context while it still exists: the -f Dockerfile
        // and the context dir are the trailing args.
        const fIdx = call.args.indexOf("-f");
        dockerfileText = await readFile(call.args[fIdx + 1], "utf8");
        const contextDir = call.args[call.args.length - 1];
        contextRecipe = await readFile(join(contextDir, ".valet", "prebuild.yaml"), "utf8");
      },
    });
    const code = await runPrebuild(["build", repoDir, "--tag", "test/mono:local"], deps);
    expect(code).toBe(ExitCode.OK);

    const clone = deps.streams.find((s) => s.cmd === "sh");
    expect(clone?.args[1]).toContain("git clone --quiet .");
    expect(clone?.args[1]).toContain("checkout --quiet --detach HEAD");
    expect(clone?.cwd).toBe(repoDir);

    const docker = deps.streams.find((s) => s.cmd === "docker");
    expect(docker?.args).toContain("-t");
    expect(docker?.args).toContain("test/mono:local");
    expect(docker?.env?.DOCKER_BUILDKIT).toBe("1");
    expect(dockerfileText).toContain("COPY . /prebuilt/repo");
    expect(dockerfileText).toContain("RUN echo hi");
    // The working-tree recipe (with the uncommitted edit) rode into the context.
    expect(contextRecipe).toContain('workspaceStorage: "4Gi"');
    expect(stdout()).toContain("built test/mono:local");
  });

  it("--no-cache passes through to docker build", async () => {
    await writeRecipe("setup:\n  - echo hi\n");
    const deps = fakeDeps({ rootFiles: [] });
    await runPrebuild(["build", repoDir, "--no-cache"], deps);
    const docker = deps.streams.find((s) => s.cmd === "docker");
    expect(docker?.args).toContain("--no-cache");
  });
});

describe("defaultImageTag", () => {
  it("lowercases and sanitizes the repo dir name", () => {
    expect(defaultImageTag("/tmp/My Repo!")).toBe("valet-prebuild-local/my-repo-");
    expect(defaultImageTag("/tmp/mono")).toBe("valet-prebuild-local/mono");
  });
});
