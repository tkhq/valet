import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DockerSandboxProvider } from "../src/index.js";

const image = process.env.VALET_SANDBOX_IMAGE;

/** Poll predicate until it returns true or the timeout elapses. */
async function waitFor(
  predicate: () => Promise<boolean>,
  timeoutMs: number,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`waitFor: timed out after ${timeoutMs}ms`);
}

let tmp: string;
let provider: DockerSandboxProvider;

describe.skipIf(!image)("rootless docker-in-sandbox (e2e)", () => {
  beforeEach(async () => {
    tmp = await mkdtemp(join(tmpdir(), "valet-dind-"));
    provider = new DockerSandboxProvider();
  });

  afterEach(async () => {
    await rm(tmp, { recursive: true, force: true });
  });

  it(
    "builds and runs containers inside a docker:true sandbox",
    async () => {
      const sb = await provider.create({
        workspace: tmp,
        image,
        docker: true,
      });
      try {
        // The rootless daemon starts asynchronously. Poll up to 30 s.
        await waitFor(
          async () => (await sb.exec("docker version")).exitCode === 0,
          30_000,
        );

        // Run a pre-pulled image to verify `docker run` works.
        const run = await sb.exec("docker run --rm hello-world");
        expect(run.exitCode).toBe(0);
        expect(run.stdout).toContain("Hello from Docker!");

        // Build a minimal image from a scratch Dockerfile.
        const build = await sb.exec(
          "mkdir -p /tmp/ctx && printf 'FROM alpine:3.20\\nRUN echo baked-ok\\n' > /tmp/ctx/Dockerfile && docker build /tmp/ctx",
        );
        expect(build.exitCode).toBe(0);

        // Run nginx:alpine with a published port and curl the default page.
        const port = await sb.exec(
          "docker run -d -p 8099:80 --name web nginx:alpine && sleep 2 && curl -sf localhost:8099 | head -1",
        );
        expect(port.exitCode).toBe(0);
      } finally {
        await provider.destroy(sb.id);
      }
    },
    // Docker Hub pulls happen inside the sandbox daemon; allow generous time.
    14 * 60_000,
  );
});
