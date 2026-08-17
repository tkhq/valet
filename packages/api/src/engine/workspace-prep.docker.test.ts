/**
 * Docker-gated integration test for `buildWorkspacePrep` (GitHub/repo
 * integration plan, Task 9): a real clone of a tiny public repo, tokenless,
 * inside a real Docker sandbox. No `ANTHROPIC_API_KEY` needed — this only
 * exercises the prep closure directly against a real `Sandbox`, not the
 * full engine/API stack. Skipped entirely when a Docker daemon isn't
 * reachable, same idiom as `packages/sandbox-docker/test/docker-sandbox.test.ts`.
 */
import { describe, it, expect, beforeAll, beforeEach, afterEach } from "vitest";
import { spawnSync } from "node:child_process";
import { rm } from "node:fs/promises";
import { createSandboxWorkspace, DockerSandboxProvider } from "@valet/sandbox-docker";
import type { Sandbox } from "@valet/engine";
import { installCredentialHelper, configureGitIdentity, prepBinding, computeTargetDirs } from "./workspace-prep.js";

function dockerAvailable(): boolean {
  const r = spawnSync("docker", ["version", "--format", "{{.Server.Version}}"], { stdio: "pipe" });
  return r.status === 0;
}

const dockerHere = dockerAvailable();
// Skip in CI: GitHub's runner has a docker daemon but not the base images /
// network setup this real clone-into-a-sandbox test needs (it passes locally
// against a configured docker). `CI` is set by GitHub Actions.
const describeDocker = dockerHere && !process.env.CI ? describe : describe.skip;

let tmp: string;
let provider: DockerSandboxProvider;
let sandbox: Sandbox | undefined;

describeDocker("buildWorkspacePrep (docker)", () => {
  beforeAll(() => {
    if (!dockerHere) {
      // eslint-disable-next-line no-console
      console.warn("docker not available — workspace-prep docker test skipped");
    }
  });

  beforeEach(async () => {
    tmp = await createSandboxWorkspace("valet-workspace-prep-");
    provider = new DockerSandboxProvider();
    sandbox = undefined;
  });

  afterEach(async () => {
    if (sandbox?.id) await provider.destroy(sandbox.id).catch(() => {});
    await rm(tmp, { recursive: true, force: true });
  });

  it(
    "clones a tiny public repo tokenless into an empty workspace root",
    async () => {
      sandbox = await provider.create({ workspace: tmp, image: "alpine:3.20" });
      // Base alpine has neither git nor curl — a real valet sandbox image
      // ships both; install them here to isolate this test from image
      // drift.
      const install = await sandbox.exec("apk add --no-cache git curl");
      expect(install.exitCode).toBe(0);

      const repos = [
        {
          host: "github" as const,
          fullName: "octocat/Hello-World",
          cloneUrl: "https://github.com/octocat/Hello-World.git",
          auth: "auto" as const,
        },
      ];
      const dirs = computeTargetDirs(repos);

      await installCredentialHelper(sandbox, "http://127.0.0.1:1"); // unreachable — never hit for a tokenless clone of a public repo
      await configureGitIdentity(sandbox);
      for (let i = 0; i < repos.length; i++) {
        await prepBinding(sandbox, dirs[i], repos[i]);
      }

      // Run in the cloned subdir (spec decision 15: single-repo sessions clone
      // into <repoName>/, not the workspace root). `dirs[0]` is "Hello-World".
      const log = await sandbox.exec("git log -1 --format=%H", { cwd: dirs[0] });
      expect(log.exitCode).toBe(0);
      expect(log.stdout.trim().length).toBe(40); // a real commit sha landed

      const helper = await sandbox.exec("git config --global credential.helper");
      expect(helper.stdout.trim()).toBe("/usr/local/bin/git-credential-valet");
      const useHttpPath = await sandbox.exec("git config --global credential.useHttpPath");
      expect(useHttpPath.stdout.trim()).toBe("true");
    },
    60_000,
  );
});
