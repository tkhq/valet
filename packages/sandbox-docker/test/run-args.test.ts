import { describe, expect, it } from "vitest";
import { buildDockerRunArgs } from "../src/sandbox.js";

const baseOpts = {
  containerName: "valet-sandbox-test",
  image: "alpine:3.20",
  workspaceHostPath: "/tmp/valet-ws",
  network: "bridge",
};

describe("buildDockerRunArgs (pure)", () => {
  it("headless (profile omitted) publishes no ports — byte-identical pin", () => {
    const args = buildDockerRunArgs(baseOpts);
    expect(args).not.toContain("-p");
    expect(args).toEqual([
      "run",
      "-d",
      "--name",
      "valet-sandbox-test",
      "--workdir",
      "/workspace",
      "-v",
      "/tmp/valet-ws:/workspace",
      "alpine:3.20",
      "sh",
      "-c",
      "tail -f /dev/null",
    ]);
  });

  it("headless (profile: 'headless' explicit) publishes no ports — byte-identical pin", () => {
    const args = buildDockerRunArgs({ ...baseOpts, profile: "headless" });
    expect(args).not.toContain("-p");
  });

  it("full profile publishes 9000 to an ephemeral loopback port", () => {
    const args = buildDockerRunArgs({ ...baseOpts, profile: "full" });
    const idx = args.indexOf("-p");
    expect(idx).toBeGreaterThan(-1);
    expect(args[idx + 1]).toBe("127.0.0.1::9000");
  });

  it("full profile still includes the rest of the standard args, and degrades to tail when /start-full.sh is missing — byte-identical pin", () => {
    const args = buildDockerRunArgs({ ...baseOpts, profile: "full" });
    expect(args).toEqual([
      "run",
      "-d",
      "--name",
      "valet-sandbox-test",
      "--workdir",
      "/workspace",
      "-v",
      "/tmp/valet-ws:/workspace",
      "-p",
      "127.0.0.1::9000",
      "alpine:3.20",
      "sh",
      "-c",
      "[ -f /start-full.sh ] && exec /bin/bash /start-full.sh || exec tail -f /dev/null",
    ]);
  });

  it("headless (profile omitted) keeps the tail placeholder trailing command — byte-identical pin", () => {
    const args = buildDockerRunArgs(baseOpts);
    expect(args.slice(-4)).toEqual(["alpine:3.20", "sh", "-c", "tail -f /dev/null"]);
  });

  it("emits --network only when non-bridge", () => {
    const bridge = buildDockerRunArgs(baseOpts);
    expect(bridge).not.toContain("--network");
    const none = buildDockerRunArgs({ ...baseOpts, network: "none" });
    const idx = none.indexOf("--network");
    expect(idx).toBeGreaterThan(-1);
    expect(none[idx + 1]).toBe("none");
  });

  it("emits --env per entry", () => {
    const args = buildDockerRunArgs({ ...baseOpts, env: { FOO: "bar", BAZ: "qux" } });
    expect(args).toEqual(
      expect.arrayContaining(["--env", "FOO=bar", "--env", "BAZ=qux"]),
    );
  });

  it("emits --cpus/--memory when resources are set", () => {
    const args = buildDockerRunArgs({ ...baseOpts, resources: { cpu: 2, memory: "4Gi" } });
    expect(args).toEqual(expect.arrayContaining(["--cpus", "2", "--memory", "4Gi"]));
  });

  it("is a pure function — identical inputs produce deep-equal output", () => {
    const first = buildDockerRunArgs({ ...baseOpts, profile: "full", env: { A: "1" } });
    const second = buildDockerRunArgs({ ...baseOpts, profile: "full", env: { A: "1" } });
    expect(first).toEqual(second);
  });
});
