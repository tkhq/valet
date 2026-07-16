import { spawn } from "node:child_process";

/**
 * Full-profile containers run `/bin/bash /start-full.sh` as their command
 * (see `buildDockerRunArgs` in ../src/sandbox.ts) instead of the headless
 * `tail -f /dev/null` placeholder — mirroring the kubernetes provider, only
 * full-profile images are guaranteed to carry that script. `alpine:3.20`
 * (used for the headless-shaped fixtures elsewhere in this suite) has
 * neither bash nor the script, so any test exercising `profile: "full"`
 * needs an image that does.
 *
 * This builds a throwaway local image once per test run: node:20-bookworm
 * (has bash) plus a stub /start-full.sh that just keeps the container
 * alive — close enough to the real script's headless fallback behavior for
 * FS/exec/gatewayEndpoint assertions that don't depend on the gateway
 * daemon actually running. Memoized process-wide so every test file that
 * imports it shares one build + one tag.
 */
export const FULL_PROFILE_TEST_IMAGE = "valet-sandbox-docker-test-full:latest";

let build: Promise<string> | undefined;

export function buildFullProfileTestImage(): Promise<string> {
  if (!build) {
    build = new Promise<string>((resolveBuild, rejectBuild) => {
      const dockerfile = [
        "FROM node:20-bookworm",
        "RUN printf '#!/bin/bash\\nexec tail -f /dev/null\\n' > /start-full.sh && chmod +x /start-full.sh",
        "",
      ].join("\n");
      const child = spawn("docker", ["build", "-t", FULL_PROFILE_TEST_IMAGE, "-"], {
        stdio: ["pipe", "ignore", "pipe"],
      });
      let stderr = "";
      child.stderr?.setEncoding("utf8");
      child.stderr?.on("data", (chunk: string) => {
        stderr += chunk;
      });
      child.on("error", rejectBuild);
      child.on("close", (code) => {
        if (code === 0) resolveBuild(FULL_PROFILE_TEST_IMAGE);
        else rejectBuild(new Error(`docker build (full-profile test image) failed (${code}): ${stderr}`));
      });
      child.stdin?.write(dockerfile);
      child.stdin?.end();
    });
  }
  return build;
}
