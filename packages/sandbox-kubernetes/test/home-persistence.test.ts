import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, writeFile, rm, symlink, lstat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { buildSandboxManifest } from "../src/manifest.js";
import { SANDBOX_CR_API_VERSION } from "../src/types.js";
import { homeInitScript, homeLinkScript, type PersistentHome } from "../src/home-persistence.js";

const cleanup: string[] = [];
afterEach(async () => { await Promise.all(cleanup.splice(0).map((path) => rm(path, { recursive: true, force: true }))); });
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "valet-home-"));
  cleanup.push(root);
  const home = join(root, "home");
  const volume = join(root, "volume");
  await mkdir(home); await mkdir(volume);
  const users: PersistentHome[] = [{ name: "test", path: home, uid: process.getuid!(), gid: process.getgid!() }];
  return { home, volume, users };
}
function run(script: string) { execFileSync("sh", ["-eu", "-c", script]); }

describe("persistent home state", () => {
  it("seeds defaults once and preserves user edits across new container homes", async () => {
    const { home, volume, users } = await fixture();
    await mkdir(join(home, ".config"));
    await writeFile(join(home, ".config", "tool"), "image default");
    await writeFile(join(home, ".gitconfig"), "[user]\n name = Image\n");
    run(homeInitScript(users, volume));
    await writeFile(join(volume, "test", ".config", "tool"), "user edit");
    await writeFile(join(home, ".config", "tool"), "new image default");
    run(homeInitScript(users, volume));
    expect(await readFile(join(volume, "test", ".config", "tool"), "utf8")).toBe("user edit");
    run(homeLinkScript(users, volume));
    execFileSync("git", ["config", "--file", join(home, ".gitconfig"), "user.name", "User"]);
    expect(await readFile(join(volume, "test", ".gitconfig"), "utf8")).toContain("User");
    expect((await lstat(join(home, ".gitconfig"))).isSymbolicLink()).toBe(true);
  });

  it("rejects a symlink in the reserved backing path", async () => {
    const { home, volume, users } = await fixture();
    await symlink(home, join(volume, "test"));
    expect(() => run(homeInitScript(users, volume))).toThrow();
  });

  it("uses the existing claim and seeds home paths before the workload starts", () => {
    const manifest = buildSandboxManifest({ namespace: "test", defaultImage: "image:v1", apiVersion: SANDBOX_CR_API_VERSION }, "test", { docker: true });
    expect(manifest.spec.volumeClaimTemplates).toHaveLength(1);
    const pod = manifest.spec.podTemplate.spec;
    expect(pod.initContainers?.[0]?.image).toBe("image:v1");
    const mounts = pod.containers[0].volumeMounts!;
    expect(mounts).toContainEqual({ name: "workspace", mountPath: "/workspace", subPath: ".valet-storage/workspace" });
    for (const user of ["root", "dockerd"]) {
      const home = user === "root" ? "/root" : "/home/dockerd";
      for (const path of [".config", ".cache", ".local", ".ssh", ".npm", ".cargo", ".rustup", ".bun", ".nvm", "go"]) {
        expect(mounts).toContainEqual({ name: "workspace", mountPath: `${home}/${path}`, subPath: `.valet-storage/home/${user}/${path}` });
      }
    }
    expect(mounts).toContainEqual({ name: "docker-state", mountPath: "/home/dockerd/.local/share/docker" });
    expect(mounts.some((m) => m.mountPath === "/etc/valet")).toBe(false);
  });
});

it("adopts an old template without losing commands, sidecars, resources, or annotations", async () => {
  const { withPersistentHomes } = await import("../src/home-persistence.js");
  const template = { metadata: { annotations: { custom: "keep" } }, spec: {
    containers: [{ name: "sandbox", image: "custom:v1", command: ["run", "--flag"], args: ["argument"],
      resources: { limits: { cpu: "2" } }, volumeMounts: [{ name: "workspace", mountPath: "/workspace" }] },
      { name: "sidecar", image: "side:v1" }],
    initContainers: [{ name: "existing-init", image: "init:v1" }],
  } };
  const adopted = withPersistentHomes(template);
  expect(adopted).toMatchObject({ metadata: template.metadata, spec: { containers: [
    { name: "sandbox", image: "custom:v1", args: ["argument"], resources: { limits: { cpu: "2" } } },
    { name: "sidecar", image: "side:v1" },
  ], initContainers: [{ name: "valet-home-init", image: "custom:v1" }, { name: "existing-init", image: "init:v1" }] } });
  expect(withPersistentHomes(adopted)).toEqual(adopted);
});

it("migrates a legacy root repository without exposing home data to git clean", async () => {
  const { migrateWorkspaceScript } = await import("../src/home-persistence.js");
  const { volume } = await fixture();
  execFileSync("git", ["init", volume]);
  execFileSync("git", ["-C", volume, "-c", "user.name=Test", "-c", "user.email=test@example.test", "-c", "commit.gpgsign=false", "commit", "--allow-empty", "-m", "unpublished"]);
  const head = execFileSync("git", ["-C", volume, "rev-parse", "HEAD"], { encoding: "utf8" });
  await writeFile(join(volume, "unpublished.txt"), "local work");
  await mkdir(join(volume, ".cache"));
  await writeFile(join(volume, ".cache", "build"), "cached build");
  run(migrateWorkspaceScript(volume));
  const workspace = join(volume, ".valet-storage", "workspace");
  const homes = join(volume, ".valet-storage", "home");
  expect(execFileSync("git", ["-C", workspace, "rev-parse", "HEAD"], { encoding: "utf8" })).toBe(head);
  expect((await lstat(workspace)).mode & 0o020).toBe(0o020);
  await mkdir(homes, { recursive: true });
  await writeFile(join(homes, "config"), "preserved");
  expect(await readFile(join(workspace, "unpublished.txt"), "utf8")).toBe("local work");
  expect(await readFile(join(workspace, ".cache", "build"), "utf8")).toBe("cached build");
  run(migrateWorkspaceScript(volume));
  execFileSync("git", ["-C", workspace, "clean", "-fdx"]);
  expect(await readFile(join(homes, "config"), "utf8")).toBe("preserved");
});

it("resumes an interrupted migration and refuses conflicting destinations", async () => {
  const { migrateWorkspaceScript } = await import("../src/home-persistence.js");
  const { volume } = await fixture();
  const storage = join(volume, ".valet-storage");
  await mkdir(join(storage, "workspace"), { recursive: true });
  await writeFile(join(storage, "migrating-v1"), "");
  await writeFile(join(storage, "workspace", "moved"), "first");
  await writeFile(join(volume, "remaining"), "second");
  run(migrateWorkspaceScript(volume));
  expect(await readFile(join(storage, "workspace", "moved"), "utf8")).toBe("first");
  expect(await readFile(join(storage, "workspace", "remaining"), "utf8")).toBe("second");
  await rm(join(storage, "layout-v1"));
  await writeFile(join(storage, "migrating-v1"), "");
  await writeFile(join(volume, "moved"), "conflicting");
  expect(() => run(migrateWorkspaceScript(volume))).toThrow();
  expect(await readFile(join(storage, "workspace", "moved"), "utf8")).toBe("first");
  expect(await readFile(join(volume, "moved"), "utf8")).toBe("conflicting");
});


it("recovers the empty-directory migration crash window", async () => {
  const { migrateWorkspaceScript } = await import("../src/home-persistence.js");
  const { volume } = await fixture();
  await mkdir(join(volume, ".valet-storage"));
  await writeFile(join(volume, "work"), "keep");
  run(migrateWorkspaceScript(volume));
  expect(await readFile(join(volume, ".valet-storage", "workspace", "work"), "utf8")).toBe("keep");
});
