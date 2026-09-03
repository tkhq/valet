/**
 * `valet prebuild` — test a repo's `.valet/prebuild.yaml` locally, without a
 * running Valet instance (TKAI-385 follow-on: recipes were untestable outside
 * the platform because the baked Dockerfile clones the repo with a minted git
 * token that only exists server-side).
 *
 * Subcommands:
 *   plan  [path]   Resolve and print the recipe a bake would run: detected
 *                  install steps, `setup` commands, and the session knobs
 *                  (`docker`, `workspaceStorage`). `--dockerfile` also prints
 *                  the local-build Dockerfile. No docker daemon needed.
 *   build [path]   Run the recipe as a real `docker build` against the local
 *                  checkout, streaming BuildKit output. Layer caching makes
 *                  re-runs after editing one step cheap.
 *
 * ── Source discipline ────────────────────────────────────────────────────
 * The build context is a LOCAL `git clone` of the checkout (detached at
 * HEAD) in a temp dir, NOT a `COPY` of the working tree. Three reasons:
 *   1. Parity: the platform bake is `git clone` + `git checkout <sha>`, so
 *      `/prebuilt/repo/.git` EXISTS during setup commands — and real repos
 *      depend on it (mono's Makefiles locate the repo root via
 *      `git rev-parse`; found the hard way when an archive-based context
 *      failed a build the platform would have passed).
 *   2. Cleanliness: a working tree full of build artifacts (node_modules,
 *      target/) is not what the platform bakes.
 *   3. Size: the clone carries the repo + history but never the working
 *      tree's multi-GB artifact dirs.
 * The ONE exception is `.valet/prebuild.yaml` itself: it is read from (and
 * copied into the context from) the WORKING TREE, so a recipe can be
 * iterated on without committing each attempt.
 *
 * The pure `runPrebuild` is exported for tests; docker probing, spawning,
 * and the git archive step are injected.
 */
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import {
  detectRecipe,
  generateLocalDockerfile,
  loadPrebuildOverride,
  resolveRecipe,
  PREBUILT_REPO_PATH,
} from "../../prebuilds/recipe.js";
import { DEFAULT_FULL_BASE_IMAGE } from "../../providers/sandbox-backend.js";
import { detectDockerDaemon } from "../docker-detect.js";
import { ExitCode } from "../exit.js";
import { parseGlobalFlags, printErr, printLine } from "../output.js";
import type { CliContext } from "../types.js";

const USAGE = `valet prebuild <plan|build> [path] [options]

Test a repo's .valet/prebuild.yaml locally.

Subcommands:
  plan   [path]   Print the resolved recipe (detected steps, setup commands,
                  docker/workspaceStorage knobs). --dockerfile also prints the
                  local-build Dockerfile. Needs git, not docker.
  build  [path]   docker-build the recipe against the committed tree
                  (git archive HEAD), streaming BuildKit output.

Options:
  --dockerfile        (plan) Also print the local-build Dockerfile
  --base <image>      Base image (default: ${DEFAULT_FULL_BASE_IMAGE})
  --tag <tag>         (build) Image tag (default: valet-prebuild-local/<repo>)
  --no-cache          (build) Pass --no-cache to docker build
  --json              (plan) Machine-readable output

The recipe file is read from the working tree, so edits are testable without
committing; everything else builds from the committed HEAD tree.`;

/** One shell-out: exit code + stdout. Injected for tests. */
export interface ExecOutcome {
  code: number | null;
  stdout: string;
}

export interface PrebuildDeps {
  /** Docker daemon probe (plan never calls it). */
  probeDocker(): Promise<boolean>;
  /** Run a command, capture stdout (git ls-tree / rev-parse). */
  capture(cmd: string, args: string[], cwd: string): Promise<ExecOutcome>;
  /** Run a command with inherited stdio (docker build; git archive|tar). */
  stream(cmd: string, args: string[], opts: { cwd: string; env?: NodeJS.ProcessEnv }): Promise<number | null>;
}

function defaultCapture(cmd: string, args: string[], cwd: string): Promise<ExecOutcome> {
  return new Promise((resolvePromise) => {
    const child = spawn(cmd, args, { cwd, stdio: ["ignore", "pipe", "ignore"] });
    let stdout = "";
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.on("error", () => resolvePromise({ code: null, stdout }));
    child.on("exit", (code) => resolvePromise({ code, stdout }));
  });
}

function defaultStream(
  cmd: string,
  args: string[],
  opts: { cwd: string; env?: NodeJS.ProcessEnv },
): Promise<number | null> {
  return new Promise((resolvePromise) => {
    const child = spawn(cmd, args, { cwd: opts.cwd, env: opts.env, stdio: "inherit" });
    child.on("error", () => resolvePromise(null));
    child.on("exit", (code) => resolvePromise(code));
  });
}

const DEFAULT_DEPS: PrebuildDeps = {
  probeDocker: () => detectDockerDaemon(),
  capture: defaultCapture,
  stream: defaultStream,
};

/** Working-tree reader for `loadPrebuildOverride` — see the header's source
 * discipline note (the recipe file alone comes from the working tree). */
function workingTreeReader(repoPath: string): (rel: string) => Promise<string | null> {
  return async (rel) => {
    try {
      return await readFile(join(repoPath, rel), "utf8");
    } catch {
      return null;
    }
  };
}

/** Root-level file listing from the COMMITTED tree (`git ls-tree HEAD`),
 * matching what the platform's contents-API listing sees. */
async function listCommittedRootFiles(deps: PrebuildDeps, repoPath: string): Promise<string[] | null> {
  const out = await deps.capture("git", ["ls-tree", "--name-only", "HEAD"], repoPath);
  if (out.code !== 0) return null;
  return out.stdout.split("\n").filter((line) => line.length > 0);
}

/** Docker image tags must be lowercase [a-z0-9._-]. */
export function defaultImageTag(repoPath: string): string {
  const name = basename(resolve(repoPath))
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^[.-]+/, "");
  return `valet-prebuild-local/${name || "repo"}`;
}

export async function runPrebuild(args: string[], deps: PrebuildDeps = DEFAULT_DEPS): Promise<number> {
  const { flags, rest } = parseGlobalFlags(args);
  const sub = rest[0];
  if (sub === undefined || (sub !== "plan" && sub !== "build")) {
    printErr(USAGE);
    return ExitCode.Usage;
  }
  const repoPath = resolve(rest[1] ?? ".");
  if (!existsSync(repoPath)) {
    printErr(`valet prebuild: path does not exist: ${repoPath}`);
    return ExitCode.Usage;
  }

  // ── Resolve the recipe exactly the way a bake would.
  const files = await listCommittedRootFiles(deps, repoPath);
  if (files === null) {
    printErr(
      `valet prebuild: ${repoPath} is not a git repository (or HEAD is unborn). ` +
        "Run from a checkout with at least one commit.",
    );
    return ExitCode.Usage;
  }
  const read = workingTreeReader(repoPath);
  let override;
  try {
    override = await loadPrebuildOverride(read);
  } catch (err) {
    // The recipe file exists but is invalid — the exact class of error this
    // command exists to catch before a real bake hits it.
    printErr(`valet prebuild: ${err instanceof Error ? err.message : String(err)}`);
    return 1;
  }
  const resolved = await resolveRecipe(files, read);
  // Full detection regardless of skipDetect — `resolved.recipe` carries the
  // suppression; this exists so plan can SHOW what skipDetect suppressed.
  const detected = await detectRecipe(files, read);

  const baseImage = typeof flags.base === "string" ? flags.base : (resolved.image ?? DEFAULT_FULL_BASE_IMAGE);
  const dockerfile = generateLocalDockerfile({
    baseImage,
    recipe: resolved.recipe,
    setup: resolved.setup,
  });

  if (sub === "plan") {
    if (flags.json === true) {
      printLine(
        JSON.stringify(
          {
            baseImage,
            skipDetect: override?.skipDetect === true,
            detectedSteps: detected,
            recipeSteps: resolved.recipe,
            setup: resolved.setup,
            docker: override?.docker === true,
            workspaceStorage: override?.workspaceStorage ?? null,
            ...(flags.dockerfile === true ? { dockerfile } : {}),
          },
          null,
          2,
        ),
      );
      return ExitCode.OK;
    }
    printLine(`base image:       ${baseImage}${resolved.image ? " (repo override)" : ""}`);
    printLine(`docker:           ${override?.docker === true}`);
    printLine(`workspaceStorage: ${override?.workspaceStorage ?? "(deploy default)"}`);
    printLine(`skipDetect:       ${override?.skipDetect === true}`);
    if (resolved.recipe.length === 0) {
      printLine("detected steps:   (none)");
    } else {
      printLine("detected steps:");
      for (const step of resolved.recipe) printLine(`  - [${step.id}] ${step.command}`);
    }
    // A lockfile CAN appear at the root later (a monorepo gaining a root
    // package-lock.json is the observed case) — when skipDetect hides steps,
    // say so, or the suppression looks like "nothing to detect".
    if (override?.skipDetect === true && detected.length > 0) {
      printLine(`suppressed by skipDetect: ${detected.map((s) => s.id).join(", ")}`);
    }
    if (resolved.setup.length === 0) {
      printLine("setup commands:   (none)");
    } else {
      printLine(`setup commands:   ${resolved.setup.length}`);
      for (const cmd of resolved.setup) {
        printLine(`  - ${cmd.length > 100 ? `${cmd.slice(0, 97)}...` : cmd}`);
      }
    }
    if (flags.dockerfile === true) {
      printLine("");
      printLine(dockerfile);
    }
    return ExitCode.OK;
  }

  // ── build ──────────────────────────────────────────────────────────
  if (!(await deps.probeDocker())) {
    printErr("valet prebuild build: no reachable docker daemon. Start Docker, then retry.");
    return 1;
  }

  const tagFlag = flags.tag;
  const tag = typeof tagFlag === "string" ? tagFlag : defaultImageTag(repoPath);

  const tmp = await mkdtemp(join(tmpdir(), "valet-prebuild-cli-"));
  try {
    const contextDir = join(tmp, "context");
    await mkdir(contextDir, { recursive: true });

    // Local clone, detached at HEAD — parity with the platform's
    // clone+checkout (see the header's source-discipline note). `git clone`
    // of a local path is cheap (object copy, no network).
    printLine(`cloning HEAD → ${contextDir}`);
    const cloneCode = await deps.stream(
      "sh",
      ["-c", `git clone --quiet . ${JSON.stringify(contextDir)} && git -C ${JSON.stringify(contextDir)} checkout --quiet --detach HEAD`],
      { cwd: repoPath },
    );
    if (cloneCode !== 0) {
      printErr("valet prebuild build: local git clone failed. Commit your tree (HEAD must exist) and retry.");
      return 1;
    }
    if (existsSync(join(contextDir, ".dockerignore"))) {
      printErr(
        "warning: this repo has a .dockerignore; the local build honors it but the platform bake " +
          "(a git clone) does not. Files it excludes will be missing from the local image only.",
      );
    }

    // The one working-tree file: the recipe itself, so edits are testable
    // without committing each attempt.
    const workingRecipe = await read(".valet/prebuild.yaml");
    if (workingRecipe !== null) {
      await mkdir(join(contextDir, ".valet"), { recursive: true });
      await writeFile(join(contextDir, ".valet", "prebuild.yaml"), workingRecipe);
    }

    const dockerfilePath = join(tmp, "Dockerfile");
    await writeFile(dockerfilePath, dockerfile);

    const buildArgs = [
      "build",
      "-f",
      dockerfilePath,
      "-t",
      tag,
      ...(flags["no-cache"] === true ? ["--no-cache"] : []),
      contextDir,
    ];
    printLine(`docker ${buildArgs.join(" ")}`);
    const code = await deps.stream("docker", buildArgs, {
      cwd: repoPath,
      env: { ...process.env, DOCKER_BUILDKIT: "1" },
    });
    if (code !== 0) {
      printErr(`valet prebuild build: docker build failed (exit ${code ?? "spawn error"}).`);
      // The stock default ref may not be pullable from a dev machine (deploys
      // override it via chart values) — the most common failure is the FROM.
      printErr(
        `If the failure is pulling the base image, pass --base with an image you can reach ` +
          `(e.g. a locally built valet-sandbox:dev, or your deploy's sandbox image).`,
      );
      return 1;
    }
    printLine("");
    printLine(`built ${tag}`);
    printLine(`inspect it:   docker run --rm -it ${tag} bash`);
    printLine(`repo path:    ${PREBUILT_REPO_PATH} (the platform stages this onto /workspace)`);
    printLine(`staged size:  docker run --rm ${tag} du -sh ${PREBUILT_REPO_PATH}`);
    return ExitCode.OK;
  } finally {
    await rm(tmp, { recursive: true, force: true }).catch(() => {});
  }
}

export async function run(args: string[], _ctx: CliContext): Promise<number> {
  return runPrebuild(args);
}
