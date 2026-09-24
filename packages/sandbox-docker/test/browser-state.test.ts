import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  DockerSandbox,
  DockerSandboxProvider,
  buildDockerRunArgs,
} from "../src/sandbox.js";

let root: string;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "valet-browser-state-"));
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

function sandbox() {
  return new DockerSandbox("test", {
    containerId: "test",
    workspace: join(root, "workspace"),
    containerWorkspace: "/workspace",
    image: "test",
    runtimeStateDir: join(root, "state"),
  });
}

describe("private browser file boundary", () => {
  it("rejects profile and transfer paths through ordinary file APIs", async () => {
    await expect(
      sandbox().readBinary("/var/lib/valet/browser/transfers/evidence.png"),
    ).rejects.toThrow(/working directory/i);
    await expect(
      sandbox().readBinary("/var/lib/valet/browser/profile/Cookies"),
    ).rejects.toThrow(/working directory/i);
    await expect(sandbox().readBinary("../secret")).rejects.toThrow(
      /working directory/i,
    );
  });
});

describe("browser container boundary", () => {
  const base = {
    containerName: "test",
    image: "test",
    workspaceHostPath: "/work",
    network: "bridge",
  };
  it("advertises browser support only after provider opt-in", () => {
    expect(new DockerSandboxProvider().capabilities().browserAutomation).toBe(
      false,
    );
    expect(
      new DockerSandboxProvider({ browserEnabled: true }).capabilities()
        .browserAutomation,
    ).toBe(true);
  });
  it("mounts private state and applies the restricted profile independently of the interactive profile", () => {
    const args = buildDockerRunArgs({
      ...base,
      runtimeStateDir: "/private/state",
      browserSeccompProfile: "/profiles/browser.json",
      browser: { enabled: true, viewer: true },
    });
    expect(args).toContain("/private/state:/var/lib/valet");
    expect(args).toContain("seccomp=/profiles/browser.json");
    expect(args).toContain("127.0.0.1::9000");
    expect(args.join(" ")).not.toContain("unconfined");
    expect(args.join(" ")).not.toContain("--privileged");
    expect(args.join(" ")).toContain("VALET_BROWSER_ENABLED=1");
  });
  it("fails closed when browser isolation is missing or conflicts with DinD", () => {
    expect(() =>
      buildDockerRunArgs({ ...base, browser: { enabled: true } }),
    ).toThrow(/seccomp/i);
    expect(() =>
      buildDockerRunArgs({
        ...base,
        browser: { enabled: true },
        browserSeccompProfile: "/profiles/browser.json",
        docker: true,
      }),
    ).toThrow(/Docker-in-sandbox|DinD/i);
  });
  it("keeps provider browser controls authoritative and configures bounded dev ports", () => {
    const args = buildDockerRunArgs({
      ...base,
      browser: { enabled: true },
      browserSeccompProfile: "/profiles/browser.json",
      env: {
        VALET_BROWSER_CONFINE: "0",
        VALET_BROWSER_STATE: "/workspace",
        PATH: "/workspace",
        NODE_OPTIONS: "--require /workspace/inject.cjs",
        BASH_ENV: "/workspace/inject.sh",
      },
    });
    expect(args).not.toContain("VALET_BROWSER_CONFINE=0");
    expect(args).not.toContain("VALET_BROWSER_STATE=/workspace");
    expect(args).not.toContain("PATH=/workspace");
    expect(args).not.toContain("NODE_OPTIONS=--require /workspace/inject.cjs");
    expect(args).not.toContain("BASH_ENV=/workspace/inject.sh");
    expect(args).toContain("VALET_BROWSER_DEV_PORTS=5173,3000,8080");
  });
});

it("runs browser-enabled shell commands as the workload user unless the trusted host requests privileged execution", async () => {
  const { buildDockerExecArgs } = await import("../src/sandbox.js");
  const args = buildDockerExecArgs({
    containerId: "container",
    cwd: "/workspace",
    command: "id",
    browser: true,
  });
  expect(args).toContain("dockerd");
  expect(args).toContain("VALET_SANDBOX_JWT_SECRET");
  expect(
    buildDockerExecArgs({
      containerId: "container",
      cwd: "/workspace",
      command: "id",
      browser: true,
      privileged: true,
    }),
  ).not.toContain("dockerd");
});

it("applies caller environment only after the trusted privilege boundary and clears inherited signing material", async () => {
  const { buildDockerExecArgs } = await import("../src/sandbox.js");
  const args = buildDockerExecArgs({
    containerId: "container",
    cwd: "/workspace",
    command: "true",
    browser: true,
    env: {
      PATH: "/workspace",
      LD_PRELOAD: "/workspace/inject.so",
      VALET_SANDBOX_JWT_SECRET: "forged",
    },
  });
  const boundary = args.indexOf("container");
  expect(args.slice(0, boundary)).toContain("VALET_SANDBOX_JWT_SECRET=");
  expect(args.slice(0, boundary)).toContain("LD_PRELOAD=");
  expect(args.slice(0, boundary)).not.toContain("PATH=/workspace");
  expect(args.slice(boundary + 1, boundary + 6)).toEqual([
    "/usr/bin/setpriv",
    "--no-new-privs",
    "/usr/bin/env",
    "-u",
    "VALET_SANDBOX_JWT_SECRET",
  ]);
  expect(args.indexOf("LD_PRELOAD=/workspace/inject.so")).toBeGreaterThan(
    args.indexOf("--no-new-privs"),
  );
  expect(args).not.toContain("VALET_SANDBOX_JWT_SECRET=forged");
});
