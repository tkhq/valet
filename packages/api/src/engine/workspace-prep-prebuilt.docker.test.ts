/**
 * Docker-gated integration test for the prebuilt-image fetch-on-start prep
 * variant (sandbox images v2 plan, Task 4, spec decision 7). Builds a REAL
 * prebuilt image with the T2 `DockerImageBuilder` from a tiny public repo
 * (baking an untracked marker file via a setup command), boots a real Docker
 * sandbox from that image, and drives `buildWorkspacePrep` with the prebuild
 * option — asserting the baked repo (INCLUDING the untracked marker a plain
 * `git clone` would drop) is staged into the workspace at the baked commit,
 * and that the ordinary cold-clone path still works from the same base.
 *
 * No `ANTHROPIC_API_KEY` needed. Skipped entirely when Docker is unreachable,
 * same idiom as `workspace-prep.docker.test.ts`. Network is required (clones
 * octocat/Hello-World at build + fetch time), same as that sibling test.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DockerSandboxProvider } from "@valet/sandbox-docker";
import type { Sandbox } from "@valet/engine";
import { installCredentialHelper, configureGitIdentity, prepBinding, prepPrebuiltBinding, computeTargetDirs } from "./workspace-prep.js";
import { DockerImageBuilder } from "../prebuilds/docker-builder.js";
import type { RepoBinding } from "../wire/types.js";

function dockerAvailable(): boolean {
  const r = spawnSync("docker", ["version", "--format", "{{.Server.Version}}"], { stdio: "pipe" });
  return r.status === 0;
}

const dockerHere = dockerAvailable();
// Skip in CI (see workspace-prep.docker.test.ts): needs real docker base
// images / prebuilt-image infra the GitHub runner lacks. `CI` = GitHub Actions.
const describeDocker = dockerHere && !process.env.CI ? describe : describe.skip;

const CLONE_URL = "https://github.com/octocat/Hello-World.git";
const BASE_IMAGE = "valet-t4-test-base:git";
const IMAGE_REF = "valet-prebuild-test/hello-world:t4";
const MARKER = "baked-by-prebuild";

/** `git ls-remote` the repo's default-branch HEAD so the baked commit is real
 * (the Dockerfile `git checkout`s it) without hardcoding a sha that could
 * rot. */
function resolveHeadSha(): string {
  const r = spawnSync("git", ["ls-remote", CLONE_URL, "HEAD"], { stdio: "pipe", encoding: "utf8" });
  if (r.status !== 0) throw new Error(`git ls-remote failed: ${r.stderr}`);
  const sha = r.stdout.split(/\s+/)[0];
  if (!/^[0-9a-f]{40}$/.test(sha)) throw new Error(`unexpected ls-remote sha: ${sha}`);
  return sha;
}

async function waitForBuild(builder: DockerImageBuilder, buildId: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const st = await builder.status(buildId);
    if (st.state === "pushed") return;
    if (st.state === "failed") throw new Error(`prebuild failed: ${st.error}\n${st.logTail ?? ""}`);
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error("prebuild timed out");
}

describeDocker("prebuilt-image fetch-on-start prep (docker)", () => {
  let bakedSha: string;
  let tmp: string;
  let provider: DockerSandboxProvider;
  let sandbox: Sandbox | undefined;

  beforeAll(async () => {
    if (!dockerHere) return;
    // A tiny base image WITH git — the prebuild Dockerfile's first RUN is the
    // clone, so git must already be present in the base.
    const build = spawnSync(
      "docker",
      ["build", "-t", BASE_IMAGE, "-"],
      { input: "FROM alpine:3.20\nRUN apk add --no-cache git\n", stdio: "pipe", encoding: "utf8" },
    );
    if (build.status !== 0) throw new Error(`base image build failed: ${build.stderr}`);

    bakedSha = resolveHeadSha();
    const builder = new DockerImageBuilder();
    const { buildId } = await builder.build({
      configId: "t4-cfg",
      prebuildId: "pb-t4",
      cloneUrl: CLONE_URL,
      commitSha: bakedSha,
      baseImage: BASE_IMAGE,
      recipe: [],
      // Bakes an UNTRACKED file into /prebuilt/repo — a plain local git clone
      // would drop it; `cp -a` must preserve it.
      setup: [`sh -c 'echo ${MARKER} > BAKED_MARKER.txt'`],
      imageRef: IMAGE_REF,
    });
    await waitForBuild(builder, buildId, 180_000);
  }, 240_000);

  afterAll(() => {
    if (!dockerHere) return;
    spawnSync("docker", ["rmi", "-f", IMAGE_REF, BASE_IMAGE], { stdio: "pipe" });
  });

  beforeEach(async () => {
    tmp = await mkdtemp(join(tmpdir(), "valet-t4-prep-"));
    provider = new DockerSandboxProvider();
    sandbox = undefined;
  });

  afterEach(async () => {
    if (sandbox?.id) await provider.destroy(sandbox.id).catch(() => {});
    await rm(tmp, { recursive: true, force: true });
  });

  const binding: RepoBinding = {
    host: "github",
    fullName: "octocat/Hello-World",
    cloneUrl: CLONE_URL,
    auth: "auto",
  };

  it(
    "stages the baked repo (with untracked artifacts) into the workspace at the baked commit",
    async () => {
      sandbox = await provider.create({ workspace: tmp, image: IMAGE_REF });

      const dirs = computeTargetDirs([binding]);
      await installCredentialHelper(sandbox, "http://127.0.0.1:1"); // unreachable — tokenless public repo
      await configureGitIdentity(sandbox);
      await prepPrebuiltBinding(sandbox, dirs[0], binding, { bakedSha, recipe: [] });

      // The repo landed in its subdir (spec decision 15: single-repo sessions
      // clone into <repoName>/, not the workspace root). `dirs[0]` is "Hello-World".
      const head = await sandbox.exec("git rev-parse HEAD", { cwd: dirs[0] });
      expect(head.exitCode).toBe(0);
      expect(head.stdout.trim()).toBe(bakedSha);

      // The untracked marker the baked setup produced survived the `cp -a`
      // staging — proof we did NOT re-clone (which would lose it).
      const marker = await sandbox.exec("cat BAKED_MARKER.txt", { cwd: dirs[0] });
      expect(marker.exitCode).toBe(0);
      expect(marker.stdout.trim()).toBe(MARKER);

      // origin was reset to the real clone url.
      const origin = await sandbox.exec("git remote get-url origin", { cwd: dirs[0] });
      expect(origin.stdout.trim()).toBe(CLONE_URL);
    },
    180_000,
  );

  it(
    "advances a freshly-staged prebuild PAST the baked commit when upstream moved, and re-runs the drifted install",
    async () => {
      // Real-git freshness scenario (spec decision 7), no external network: a
      // LOCAL bare repo stands in for `origin`. We bake at commit A (clone into
      // /prebuilt/repo), then advance the bare origin to commit B with a
      // lockfile change. `buildWorkspacePrep` must fetch + `checkout -B` the
      // workspace to B (a plain `git checkout` of the stale baked local branch
      // would stay at A), and the `bakedSha..HEAD` lockfile drift must trigger
      // the reinstall step.
      sandbox = await provider.create({ workspace: tmp, image: BASE_IMAGE });

      // Everything below runs INSIDE the container (absolute container paths).
      const setup = await sandbox.exec(
        [
          "set -e",
          "git config --global user.email seed@test.local",
          "git config --global user.name Seed",
          "git config --global --add safe.directory '*'",
          // Pin the default branch so the bare origin's HEAD and the seed's
          // branch agree (older git defaults to `master`); otherwise the bake
          // clone's origin/HEAD dangles and rev-parse HEAD fails.
          "git config --global init.defaultBranch main",
          "git init --bare /origin.git",
          "mkdir /seed && cd /seed && git init -q",
          "printf A > lock.txt && printf hello > file.txt",
          "git add -A && git commit -q -m A",
          "git remote add origin /origin.git && git push -q origin main",
          // Bake: clone at commit A into /prebuilt/repo (sets origin/HEAD).
          "git clone -q /origin.git /prebuilt/repo",
          "git -C /prebuilt/repo rev-parse HEAD > /baked_sha",
          // Advance origin to commit B (lockfile drift).
          "cd /seed && printf B > lock.txt && git add -A && git commit -q -m B && git push -q origin main",
          "git -C /seed rev-parse HEAD > /head_sha",
        ].join("\n"),
      );
      expect(setup.exitCode, setup.stderr).toBe(0);

      const bakedShaLocal = (await sandbox.exec("cat /baked_sha")).stdout.trim();
      const headShaLocal = (await sandbox.exec("cat /head_sha")).stdout.trim();
      expect(bakedShaLocal).toMatch(/^[0-9a-f]{40}$/);
      expect(headShaLocal).toMatch(/^[0-9a-f]{40}$/);
      expect(headShaLocal).not.toBe(bakedShaLocal);

      const localBinding: RepoBinding = {
        host: "github",
        fullName: "seed/repo",
        cloneUrl: "/origin.git",
        auth: "auto",
        ref: "main",
      };
      const dirs = computeTargetDirs([localBinding]);
      await installCredentialHelper(sandbox, "http://127.0.0.1:1"); // unreachable — local file remote needs no creds
      await configureGitIdentity(sandbox);
      await prepPrebuiltBinding(sandbox, dirs[0], localBinding, {
        bakedSha: bakedShaLocal,
        recipe: [{ id: "marker", lockfile: "lock.txt", command: "sh -c 'printf done > REINSTALL_MARKER.txt'" }],
      });

      // The workspace advanced to origin's head (commit B), NOT the baked A.
      // `dirs[0]` is "repo" (repoNameOf("seed/repo")).
      const head = await sandbox.exec("git rev-parse HEAD", { cwd: dirs[0] });
      expect(head.exitCode).toBe(0);
      expect(head.stdout.trim()).toBe(headShaLocal);

      // The lockfile drift (A→B) drove the conditional reinstall.
      const marker = await sandbox.exec("cat REINSTALL_MARKER.txt", { cwd: dirs[0] });
      expect(marker.exitCode).toBe(0);
      expect(marker.stdout.trim()).toBe("done");
    },
    120_000,
  );

  it(
    "cold path still works: an ordinary (non-prebuilt) session clones from the same base image",
    async () => {
      sandbox = await provider.create({ workspace: tmp, image: BASE_IMAGE });

      const dirs = computeTargetDirs([binding]);
      await installCredentialHelper(sandbox, "http://127.0.0.1:1");
      await configureGitIdentity(sandbox);
      await prepBinding(sandbox, dirs[0], binding);

      // `dirs[0]` is "Hello-World" (repoNameOf("octocat/Hello-World")).
      const log = await sandbox.exec("git log -1 --format=%H", { cwd: dirs[0] });
      expect(log.exitCode).toBe(0);
      expect(log.stdout.trim().length).toBe(40);
      // No baked marker on the cold path — it was a fresh clone.
      const marker = await sandbox.exec(`test -f ${dirs[0]}/BAKED_MARKER.txt`);
      expect(marker.exitCode).not.toBe(0);
    },
    120_000,
  );
});
