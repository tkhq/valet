/**
 * Unit coverage for `installCredentialHelper`, `configureGitIdentity`,
 * `prepBinding`, and `prepPrebuiltBinding` against a recording fake `Sandbox`
 * — no engine, no docker. See `workspace-prep.ts`'s header for the sequence
 * and the relative-path discipline this pins.
 *
 * These tests were ported from the old `buildWorkspacePrep` closure tests
 * (sandbox-reconciliation plan, Task 6) — the behavior is preserved exactly;
 * only the call shape changed from a single closure to per-step function calls.
 */
import { describe, it, expect, vi } from "vitest";
import type { ExecOpts, ExecResult, Sandbox } from "@valet/engine";
import {
  installCredentialHelper,
  configureGitIdentity,
  prepBinding,
  prepPrebuiltBinding,
  computeTargetDirs,
  resolveStartRef,
} from "./workspace-prep.js";
import { gitCredentialHelperScript, ghWrapperScript } from "./git-credential-helper.js";
import type { RepoBinding } from "../wire/types.js";

const API_URL = "https://api.valet.test";
const STAGED_HELPER = ".valet-prep/git-credential-valet";
const STAGED_GH = ".valet-prep/valet-gh";
const INSTALL_CMD =
  "mkdir -p /usr/local/bin && cp '.valet-prep/git-credential-valet' /usr/local/bin/git-credential-valet && cp '.valet-prep/valet-gh' /usr/local/bin/valet-gh && cp '.valet-prep/valet-gh' /usr/local/bin/gh && chmod 755 /usr/local/bin/git-credential-valet /usr/local/bin/valet-gh /usr/local/bin/gh";

interface ExecCall {
  command: string;
  opts?: ExecOpts;
}

/** Recording fake `Sandbox`: tracks every `exec`/`writeFile` call and lets
 * the test script per-command exit codes (default success) and a fake
 * filesystem (`.git` presence, directory contents) for the layout /
 * existing-clone branches. Directory keys are workspace-relative, matching
 * `workspace-prep.ts`'s relative-path discipline (`.` = workspace root). */
class RecordingSandbox implements Sandbox {
  readonly id = "sb-test";
  execCalls: ExecCall[] = [];
  writes = new Map<string, string>();
  private gitDirs = new Set<string>();
  private dirs = new Map<string, string[]>();
  execResults = new Map<string, ExecResult>();

  /** Mark `<dir>/.git` as present, so `dirHasGit` reports an existing clone. */
  markExistingClone(dir: string): void {
    this.gitDirs.add(dir);
  }

  /** Mark `dir` as present with the given entries (empty array = exists-but-empty). */
  setDirEntries(dir: string, entries: string[]): void {
    this.dirs.set(dir, entries);
  }

  /** Override the result for an exact command string. */
  setResult(command: string, result: ExecResult): void {
    this.execResults.set(command, result);
  }

  async readFile(): Promise<string> {
    throw new Error("not implemented");
  }
  async readBinary(): Promise<Uint8Array> {
    throw new Error("not implemented");
  }
  async writeFile(path: string, content: string): Promise<void> {
    this.writes.set(path, content);
  }
  async writeBinary(): Promise<void> {
    throw new Error("not implemented");
  }
  async readdir(path: string): Promise<string[]> {
    const entries = this.dirs.get(path);
    if (entries === undefined) throw new Error(`ENOENT: ${path}`);
    return entries;
  }
  async stat(path: string): Promise<{ isFile: boolean; isDirectory: boolean; size: number }> {
    if (path.endsWith("/.git") && this.gitDirs.has(path.slice(0, -"/.git".length))) {
      return { isFile: false, isDirectory: true, size: 0 };
    }
    throw new Error(`ENOENT: ${path}`);
  }
  async mkdir(): Promise<void> {}
  async rm(): Promise<void> {}
  async exec(command: string, opts?: ExecOpts): Promise<ExecResult> {
    this.execCalls.push({ command, opts });
    return this.execResults.get(command) ?? { stdout: "", stderr: "", exitCode: 0 };
  }
}

function binding(overrides: Partial<RepoBinding> = {}): RepoBinding {
  return {
    host: "github",
    fullName: "acme/widgets",
    cloneUrl: "https://github.com/acme/widgets.git",
    auth: "auto",
    ...overrides,
  };
}

describe("installCredentialHelper", () => {
  it("stages the credential helper + gh wrapper verbatim at a workspace-relative path, installs into /usr/local/bin, and wires git config", async () => {
    const sandbox = new RecordingSandbox();
    await installCredentialHelper(sandbox, API_URL);

    // Never writeFile'd directly to an absolute /usr/local/bin path — see
    // the file header on why that's broken for sandbox-docker.
    expect(sandbox.writes.get(STAGED_HELPER)).toBe(gitCredentialHelperScript(API_URL));
    expect(sandbox.writes.get(STAGED_GH)).toBe(ghWrapperScript(API_URL));
    expect(sandbox.writes.has("/usr/local/bin/git-credential-valet")).toBe(false);

    const commands = sandbox.execCalls.map((c) => c.command);
    expect(commands).toContain(INSTALL_CMD);
    expect(commands).toContain("git config --global credential.helper '/usr/local/bin/git-credential-valet'");
    // Hard prerequisite (Task 8 review): without this, git never sends
    // `path=` to the helper and every clone runs anonymous.
    expect(commands).toContain("git config --global credential.useHttpPath true");
    // Discovered against a real Docker sandbox: without this, git refuses
    // to operate on the bind-mounted workspace ("dubious ownership").
    expect(commands).toContain("git config --global --add safe.directory '*'");
    // Staging dir cleanup is best-effort, but still attempted.
    expect(commands).toContain("rm -rf '.valet-prep'");
  });

  it("runs ONLY the /usr/local/bin install exec privileged; git config execs stay non-privileged", async () => {
    const sandbox = new RecordingSandbox();
    await installCredentialHelper(sandbox, API_URL);

    const install = sandbox.execCalls.find((c) => c.command === INSTALL_CMD);
    expect(install?.opts?.privileged).toBe(true);

    // Every git config (and the staging cleanup) runs as the workload user
    // so /home/dockerd/.gitconfig — not /root/.gitconfig — gets the config
    // in docker-enabled sandboxes.
    for (const call of sandbox.execCalls) {
      if (call.command === INSTALL_CMD) continue;
      expect(call.opts?.privileged, call.command).toBeUndefined();
    }
  });

  it("install failure THROWS before any git config is attempted", async () => {
    const sandbox = new RecordingSandbox();
    sandbox.setResult(INSTALL_CMD, { stdout: "", stderr: "permission denied", exitCode: 1 });
    await expect(installCredentialHelper(sandbox, API_URL)).rejects.toThrow(/installing credential helper/);
    expect(sandbox.execCalls.some((c) => c.command.startsWith("git config"))).toBe(false);
  });

  it("credential.helper config failure THROWS", async () => {
    const sandbox = new RecordingSandbox();
    sandbox.setResult("git config --global credential.helper '/usr/local/bin/git-credential-valet'", {
      stdout: "",
      stderr: "permission denied",
      exitCode: 1,
    });
    await expect(installCredentialHelper(sandbox, API_URL)).rejects.toThrow(/credential.helper/);
  });
});

describe("configureGitIdentity", () => {
  it("configures user.name/user.email, falling back to a generic identity", async () => {
    const sandbox = new RecordingSandbox();
    await configureGitIdentity(sandbox);
    const commands = sandbox.execCalls.map((c) => c.command);
    expect(commands).toContain("git config --global user.name 'Valet Agent'");
    expect(commands).toContain("git config --global user.email 'agent@valet.local'");
  });

  it("uses the session owner's name/email when provided", async () => {
    const sandbox = new RecordingSandbox();
    await configureGitIdentity(sandbox, "Ada Lovelace", "ada@example.com");
    const commands = sandbox.execCalls.map((c) => c.command);
    expect(commands).toContain("git config --global user.name 'Ada Lovelace'");
    expect(commands).toContain("git config --global user.email 'ada@example.com'");
  });
});

describe("prepBinding exec identity", () => {
  it("git clone runs non-privileged (as the workload user in docker sandboxes)", async () => {
    const sandbox = new RecordingSandbox();
    await prepBinding(sandbox, "widgets", binding());
    const clone = sandbox.execCalls.find((c) => c.command.startsWith("git clone"));
    expect(clone).toBeDefined();
    expect(clone?.opts?.privileged).toBeUndefined();
  });
});

describe("computeTargetDirs (layout)", () => {
  it("single binding clones into its own subdir (spec decision 15: always <repoName>)", () => {
    expect(computeTargetDirs([binding()])).toEqual(["widgets"]);
  });

  it("multiple bindings clone each into <repoName> (relative), in position order", () => {
    const repos = [
      binding({ fullName: "acme/widgets" }),
      binding({ fullName: "acme/gadgets", cloneUrl: "https://github.com/acme/gadgets.git" }),
    ];
    expect(computeTargetDirs(repos)).toEqual(["widgets", "gadgets"]);
  });

  it("disambiguates colliding repo names to <owner>__<repo>", () => {
    const repos = [
      binding({ fullName: "acme/widgets" }),
      binding({ fullName: "beta/widgets", cloneUrl: "https://github.com/beta/widgets.git" }),
    ];
    expect(computeTargetDirs(repos)).toEqual(["acme__widgets", "beta__widgets"]);
  });

  it("only disambiguates the colliding group — non-colliding bindings keep the plain <repo> dir", () => {
    const repos = [
      binding({ fullName: "acme/widgets" }),
      binding({ fullName: "beta/widgets", cloneUrl: "https://github.com/beta/widgets.git" }),
      binding({ fullName: "acme/gadgets", cloneUrl: "https://github.com/acme/gadgets.git" }),
    ];
    expect(computeTargetDirs(repos)).toEqual(["acme__widgets", "beta__widgets", "gadgets"]);
  });
});

describe("prepBinding", () => {
  it("clones into '.' (single-binding workspace root)", async () => {
    const sandbox = new RecordingSandbox();
    await prepBinding(sandbox, ".", binding());
    const commands = sandbox.execCalls.map((c) => c.command);
    expect(commands).toContain("git clone 'https://github.com/acme/widgets.git' '.'");
  });

  it("clones with --branch when ref is set", async () => {
    const sandbox = new RecordingSandbox();
    await prepBinding(sandbox, ".", binding({ ref: "release/1.0" }));
    const commands = sandbox.execCalls.map((c) => c.command);
    expect(commands).toContain("git clone 'https://github.com/acme/widgets.git' '.' --branch 'release/1.0'");
  });

  it("clones then checks out a SHA ref — NOT --branch (git rejects a SHA there)", async () => {
    const sandbox = new RecordingSandbox();
    const sha = "f8f79e535477998412a6d16f139f94f8cd37cb9f";
    await prepBinding(sandbox, ".", binding({ ref: sha }));
    const commands = sandbox.execCalls.map((c) => c.command);
    // Plain clone (no --branch), then a detached checkout of the commit.
    expect(commands).toContain("git clone 'https://github.com/acme/widgets.git' '.'");
    expect(commands.some((c) => c.includes("--branch"))).toBe(false);
    expect(commands).toContain(`git checkout '${sha}'`);
  });

  it("fails prep when the SHA checkout fails (unreachable commit)", async () => {
    const sandbox = new RecordingSandbox();
    const sha = "f8f79e535477998412a6d16f139f94f8cd37cb9f";
    sandbox.setResult(`git checkout '${sha}'`, {
      stdout: "",
      stderr: "error: pathspec did not match",
      exitCode: 1,
    });
    await expect(prepBinding(sandbox, ".", binding({ ref: sha }))).rejects.toThrow(/git checkout/);
  });

  it("clones into an existing-but-empty workspace root (single-binding subtlety)", async () => {
    const sandbox = new RecordingSandbox();
    sandbox.setDirEntries(".", []); // root pre-created empty by session create
    await expect(prepBinding(sandbox, ".", binding())).resolves.toBeUndefined();
    const commands = sandbox.execCalls.map((c) => c.command);
    expect(commands).toContain("git clone 'https://github.com/acme/widgets.git' '.'");
  });

  it("throws when the clone target is non-empty with no .git present", async () => {
    const sandbox = new RecordingSandbox();
    sandbox.setDirEntries(".", ["some-stray-file.txt"]);
    await expect(prepBinding(sandbox, ".", binding())).rejects.toThrow(/not empty/);
  });

  it("clone failure THROWS (prep fails → startup-failure semantics)", async () => {
    const sandbox = new RecordingSandbox();
    sandbox.setResult("git clone 'https://github.com/acme/widgets.git' '.'", {
      stdout: "",
      stderr: "fatal: repository not found",
      exitCode: 128,
    });
    await expect(prepBinding(sandbox, ".", binding())).rejects.toThrow(/git clone failed/);
  });

  it("fetch+checkout an existing clone instead of cloning again", async () => {
    const sandbox = new RecordingSandbox();
    sandbox.markExistingClone(".");
    await prepBinding(sandbox, ".", binding({ ref: "main" }));
    const commands = sandbox.execCalls.map((c) => c.command);
    expect(commands.some((c) => c.startsWith("git clone"))).toBe(false);
    expect(commands).toContain("git fetch origin");
    expect(commands).toContain("git checkout 'main'");
    const fetchCall = sandbox.execCalls.find((c) => c.command === "git fetch origin");
    expect(fetchCall?.opts?.cwd).toBe(".");
  });

  it("skips checkout when no ref is pinned on an existing clone", async () => {
    const sandbox = new RecordingSandbox();
    sandbox.markExistingClone(".");
    await prepBinding(sandbox, ".", binding());
    const commands = sandbox.execCalls.map((c) => c.command);
    expect(commands).toContain("git fetch origin");
    expect(commands.some((c) => c.startsWith("git checkout"))).toBe(false);
  });

  it("offline-tolerant: fetch failure on an existing clone logs and prep continues (does not throw)", async () => {
    const sandbox = new RecordingSandbox();
    sandbox.markExistingClone(".");
    sandbox.setResult("git fetch origin", { stdout: "", stderr: "network unreachable", exitCode: 1 });
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    await expect(prepBinding(sandbox, ".", binding({ ref: "main" }))).resolves.toBeUndefined();
    expect(errSpy).toHaveBeenCalled();
    // checkout still attempted despite the fetch failure.
    expect(sandbox.execCalls.map((c) => c.command)).toContain("git checkout 'main'");
    errSpy.mockRestore();
  });

  it("offline-tolerant: checkout failure on an existing clone logs and prep continues (does not throw)", async () => {
    const sandbox = new RecordingSandbox();
    sandbox.markExistingClone(".");
    sandbox.setResult("git checkout 'main'", { stdout: "", stderr: "unknown revision", exitCode: 1 });
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    await expect(prepBinding(sandbox, ".", binding({ ref: "main" }))).resolves.toBeUndefined();
    expect(errSpy).toHaveBeenCalled();
    errSpy.mockRestore();
  });

  it("multiple bindings (position order): second binding clones into its subdir", async () => {
    const sandbox = new RecordingSandbox();
    sandbox.markExistingClone("widgets");
    sandbox.setResult("git fetch origin", { stdout: "", stderr: "offline", exitCode: 1 });
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const repos = [
      binding({ fullName: "acme/widgets" }),
      binding({ fullName: "acme/gadgets", cloneUrl: "https://github.com/acme/gadgets.git" }),
    ];
    const dirs = computeTargetDirs(repos);
    // Simulate what the specProvider does: call per-step apply in order.
    for (let i = 0; i < repos.length; i++) {
      await prepBinding(sandbox, dirs[i], repos[i]);
    }
    expect(sandbox.execCalls.map((c) => c.command)).toContain(
      "git clone 'https://github.com/acme/gadgets.git' 'gadgets'",
    );
    errSpy.mockRestore();
  });
});

describe("token discipline", () => {
  it("no token material appears in any exec argv or written file content", async () => {
    const sandbox = new RecordingSandbox();
    await installCredentialHelper(sandbox, API_URL);
    await configureGitIdentity(sandbox, "Ada Lovelace", "ada@example.com");
    await prepBinding(sandbox, ".", binding({ fullName: "acme/widgets", ref: "main" }));

    // No exec argv ever carries token-shaped material — the helper
    // resolves auth out-of-band at clone time, not via anything prep
    // passes on the command line.
    for (const call of sandbox.execCalls) {
      expect(call.command).not.toContain("VALET_SANDBOX_TOKEN=");
      expect(call.command.toLowerCase()).not.toMatch(/x-valet-sandbox:|bearer /);
    }
    // Written script content is byte-identical to Task 8's generators —
    // pinned exactly (not merely "no secret substring") — which
    // themselves assert no token material is embedded.
    expect(sandbox.writes.get(STAGED_HELPER)).toBe(gitCredentialHelperScript(API_URL));
    expect(sandbox.writes.get(STAGED_GH)).toBe(ghWrapperScript(API_URL));
  });

  it("never rewrites `git remote get-url origin` with embedded credentials (non-prebuilt path)", async () => {
    const sandbox = new RecordingSandbox();
    await prepBinding(sandbox, ".", binding());
    expect(sandbox.execCalls.some((c) => c.command.includes("remote set-url"))).toBe(false);
    expect(sandbox.execCalls.some((c) => c.command.includes("remote get-url"))).toBe(false);
  });
});

describe("prepPrebuiltBinding", () => {
  const PNPM_STEP = { id: "pnpm-install", lockfile: "pnpm-lock.yaml", command: "pnpm install --frozen-lockfile" };
  const DIFF_CMD = "git diff --name-only 'bakedsha' HEAD -- 'pnpm-lock.yaml'";

  it("cold workspace: stages the baked repo with `cp -a` (never git clone), resets origin, fetches, force-checks-out origin's ref", async () => {
    const sandbox = new RecordingSandbox();
    await prepPrebuiltBinding(sandbox, ".", binding({ ref: "main" }), { bakedSha: "bakedsha", recipe: [] });
    const commands = sandbox.execCalls.map((c) => c.command);
    // Preserves untracked node_modules the baked install produced — a local
    // git clone would drop them.
    expect(commands).toContain("mkdir -p '.' && cp -a /prebuilt/repo/. '.'");
    expect(commands.some((c) => c.startsWith("git clone"))).toBe(false);
    expect(commands).toContain("git remote set-url origin 'https://github.com/acme/widgets.git'");
    expect(commands).toContain("git fetch origin");
    // The baked LOCAL `main` sits at bakedSha; a plain `git checkout main`
    // would stay there (git does not fast-forward an existing branch on
    // checkout), so the workspace would never reach upstream head. A
    // reset-to-origin `checkout -B main origin/main` is the only form that
    // advances the freshly-staged tree past the baked commit.
    expect(commands).toContain("git checkout -B 'main' 'origin/main'");
    expect(commands.some((c) => c === "git checkout 'main'")).toBe(false);
  });

  it("cold workspace, no ref pinned: resolves origin/HEAD's default branch and force-checks-out origin's head", async () => {
    const sandbox = new RecordingSandbox();
    sandbox.setResult("git symbolic-ref refs/remotes/origin/HEAD", {
      stdout: "refs/remotes/origin/trunk\n",
      stderr: "",
      exitCode: 0,
    });
    await prepPrebuiltBinding(sandbox, ".", binding(), { bakedSha: "bakedsha", recipe: [] });
    const commands = sandbox.execCalls.map((c) => c.command);
    expect(commands).toContain("git symbolic-ref refs/remotes/origin/HEAD");
    expect(commands).toContain("git checkout -B 'trunk' 'origin/trunk'");
  });

  it("cold workspace, no ref and origin/HEAD unresolvable: stays at the baked commit (no checkout), logs", async () => {
    const sandbox = new RecordingSandbox();
    sandbox.setResult("git symbolic-ref refs/remotes/origin/HEAD", {
      stdout: "",
      stderr: "ref refs/remotes/origin/HEAD is not a symbolic ref",
      exitCode: 1,
    });
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    await expect(prepPrebuiltBinding(sandbox, ".", binding(), { bakedSha: "bakedsha", recipe: [] })).resolves.toBeUndefined();
    const commands = sandbox.execCalls.map((c) => c.command);
    expect(commands.some((c) => c.startsWith("git checkout"))).toBe(false);
    expect(errSpy).toHaveBeenCalled();
    errSpy.mockRestore();
  });

  it("cold workspace: fetch failure stays at the baked commit — no checkout, no reinstall (offline-tolerant)", async () => {
    const sandbox = new RecordingSandbox();
    sandbox.setResult("git fetch origin", { stdout: "", stderr: "offline", exitCode: 1 });
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    await expect(
      prepPrebuiltBinding(sandbox, ".", binding({ ref: "main" }), { bakedSha: "bakedsha", recipe: [PNPM_STEP] }),
    ).resolves.toBeUndefined();
    const commands = sandbox.execCalls.map((c) => c.command);
    // Fetch failed → do NOT advance the tree; leaving HEAD at the baked sha
    // means the `bakedSha..HEAD` diff is empty and no install re-runs.
    expect(commands.some((c) => c.startsWith("git checkout"))).toBe(false);
    expect(commands.some((c) => c.startsWith("git symbolic-ref"))).toBe(false);
    expect(commands.some((c) => c.startsWith("git diff"))).toBe(false);
    expect(commands.some((c) => c === "pnpm install --frozen-lockfile")).toBe(false);
    expect(errSpy).toHaveBeenCalled();
    errSpy.mockRestore();
  });

  it("re-runs an install whose lockfile drifted between the baked sha and head", async () => {
    const sandbox = new RecordingSandbox();
    sandbox.setResult(DIFF_CMD, { stdout: "pnpm-lock.yaml\n", stderr: "", exitCode: 0 });
    await prepPrebuiltBinding(sandbox, ".", binding(), { bakedSha: "bakedsha", recipe: [PNPM_STEP] });
    const installCall = sandbox.execCalls.find((c) => c.command === "pnpm install --frozen-lockfile");
    expect(installCall).toBeDefined();
    expect(installCall?.opts?.cwd).toBe(".");
  });

  it("skips the install when the lockfile is unchanged (cheap path)", async () => {
    const sandbox = new RecordingSandbox();
    sandbox.setResult(DIFF_CMD, { stdout: "", stderr: "", exitCode: 0 });
    await prepPrebuiltBinding(sandbox, ".", binding(), { bakedSha: "bakedsha", recipe: [PNPM_STEP] });
    expect(sandbox.execCalls.some((c) => c.command === "pnpm install --frozen-lockfile")).toBe(false);
  });

  it("a failed reinstall degrades to a logged warning — prep completes so the prebuild stays an optimization, never a correctness dependency", async () => {
    const sandbox = new RecordingSandbox();
    sandbox.setResult(DIFF_CMD, { stdout: "pnpm-lock.yaml\n", stderr: "", exitCode: 0 });
    sandbox.setResult("pnpm install --frozen-lockfile", { stdout: "", stderr: "ERR_PNPM", exitCode: 1 });
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    await expect(
      prepPrebuiltBinding(sandbox, ".", binding(), { bakedSha: "bakedsha", recipe: [PNPM_STEP] }),
    ).resolves.toBeUndefined();
    expect(errSpy).toHaveBeenCalledWith(expect.stringMatching(/prebuild reinstall/));
    errSpy.mockRestore();
  });

  it("cp staging failure THROWS", async () => {
    const sandbox = new RecordingSandbox();
    sandbox.setResult("mkdir -p '.' && cp -a /prebuilt/repo/. '.'", { stdout: "", stderr: "no space", exitCode: 1 });
    await expect(
      prepPrebuiltBinding(sandbox, ".", binding(), { bakedSha: "bakedsha", recipe: [] }),
    ).rejects.toThrow(/staging prebuilt repo/);
  });

  it("existing clone (restore / warm workspace): refreshes in place, never stages the image or reinstalls", async () => {
    const sandbox = new RecordingSandbox();
    sandbox.markExistingClone(".");
    await prepPrebuiltBinding(sandbox, ".", binding({ ref: "main" }), {
      bakedSha: "bakedsha",
      recipe: [PNPM_STEP],
    });
    const commands = sandbox.execCalls.map((c) => c.command);
    expect(commands.some((c) => c.includes("cp -a /prebuilt/repo"))).toBe(false);
    expect(commands).toContain("git fetch origin");
    expect(commands).toContain("git checkout 'main'");
    // Baked-image diff/reinstall is skipped — the workspace copy is authoritative.
    expect(commands.some((c) => c.startsWith("git diff"))).toBe(false);
    expect(commands.some((c) => c === "pnpm install --frozen-lockfile")).toBe(false);
  });

  it("only the primary (index-0) binding is prebuilt — a second binding uses prepBinding (clones normally)", async () => {
    const sandbox = new RecordingSandbox();
    const repos = [
      binding({ fullName: "acme/widgets" }),
      binding({ fullName: "acme/gadgets", cloneUrl: "https://github.com/acme/gadgets.git" }),
    ];
    const dirs = computeTargetDirs(repos);
    // Simulate buildPrepSteps behavior: index-0 uses prepPrebuiltBinding, index-1 uses prepBinding.
    await prepPrebuiltBinding(sandbox, dirs[0], repos[0], { bakedSha: "bakedsha", recipe: [] });
    await prepBinding(sandbox, dirs[1], repos[1]);
    const commands = sandbox.execCalls.map((c) => c.command);
    // primary staged from the image (into its subdir), secondary cloned.
    expect(commands).toContain("mkdir -p 'widgets' && cp -a /prebuilt/repo/. 'widgets'");
    expect(commands).toContain("git clone 'https://github.com/acme/gadgets.git' 'gadgets'");
    expect(commands.some((c) => c.startsWith("git clone 'https://github.com/acme/widgets.git'"))).toBe(false);
  });
});

describe("resolveStartRef", () => {
  const RESOLVE_CMD =
    "git remote get-url origin && git rev-parse HEAD && git rev-parse --abbrev-ref HEAD";
  const SHA = "0123456789abcdef0123456789abcdef01234567";

  it("resolves the primary binding's ref and returns it", async () => {
    const sandbox = new RecordingSandbox();
    sandbox.setResult(RESOLVE_CMD, {
      stdout: `https://github.com/acme/widgets.git\n${SHA}\nmain\n`,
      stderr: "",
      exitCode: 0,
    });
    const ref = await resolveStartRef(sandbox, ".");
    expect(ref).toMatchObject({
      repoUrl: "https://github.com/acme/widgets.git",
      commitSha: SHA,
      branch: "main",
    });
    expect(typeof ref?.capturedAt).toBe("number");
    // Resolution runs against the correct dir.
    const call = sandbox.execCalls.find((c) => c.command === RESOLVE_CMD);
    expect(call?.opts?.cwd).toBe(".");
  });

  it("detached HEAD ('HEAD' from --abbrev-ref) yields branch: undefined", async () => {
    const sandbox = new RecordingSandbox();
    sandbox.setResult(RESOLVE_CMD, {
      stdout: `https://github.com/acme/widgets.git\n${SHA}\nHEAD\n`,
      stderr: "",
      exitCode: 0,
    });
    const ref = await resolveStartRef(sandbox, ".");
    expect(ref?.branch).toBeUndefined();
  });

  it("returns null on resolution failure (does not throw)", async () => {
    const sandbox = new RecordingSandbox();
    sandbox.setResult(RESOLVE_CMD, { stdout: "", stderr: "no origin", exitCode: 1 });
    const ref = await resolveStartRef(sandbox, ".");
    expect(ref).toBeNull();
  });

  it("multi-binding: resolves from the correct (primary) dir", async () => {
    const sandbox = new RecordingSandbox();
    sandbox.setResult(RESOLVE_CMD, {
      stdout: `https://github.com/acme/widgets.git\n${SHA}\nmain\n`,
      stderr: "",
      exitCode: 0,
    });
    // For a multi-binding layout, the primary dir is "widgets" (not ".").
    const repos = [binding(), binding({ fullName: "acme/gadgets", cloneUrl: "https://github.com/acme/gadgets.git" })];
    const dirs = computeTargetDirs(repos);
    await resolveStartRef(sandbox, dirs[0]);
    const call = sandbox.execCalls.find((c) => c.command === RESOLVE_CMD);
    expect(call?.opts?.cwd).toBe("widgets");
  });
});
