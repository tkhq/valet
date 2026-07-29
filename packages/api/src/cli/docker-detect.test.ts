import { describe, expect, it } from "vitest";
import { detectDockerDaemon, type DockerProbeResult } from "./docker-detect.js";

const probe = (r: DockerProbeResult) => () => Promise.resolve(r);

describe("cli/docker-detect detectDockerDaemon", () => {
  it("returns true for exit 0 with a non-empty version string", async () => {
    expect(await detectDockerDaemon(probe({ code: 0, stdout: "24.0.7\n", timedOut: false }))).toBe(true);
  });

  it("returns false for exit 0 but empty stdout", async () => {
    expect(await detectDockerDaemon(probe({ code: 0, stdout: "   \n", timedOut: false }))).toBe(false);
  });

  it("returns false when the binary is missing (ENOENT)", async () => {
    const err = Object.assign(new Error("spawn docker ENOENT"), { code: "ENOENT" });
    expect(await detectDockerDaemon(probe({ code: null, stdout: "", timedOut: false, error: err }))).toBe(false);
  });

  it("returns false on timeout", async () => {
    expect(await detectDockerDaemon(probe({ code: null, stdout: "", timedOut: true }))).toBe(false);
  });

  it("returns false on a non-zero exit (daemon unreachable)", async () => {
    expect(
      await detectDockerDaemon(probe({ code: 1, stdout: "", timedOut: false })),
    ).toBe(false);
  });

  it("returns false if the probe itself rejects", async () => {
    expect(await detectDockerDaemon(() => Promise.reject(new Error("boom")))).toBe(false);
  });
});
