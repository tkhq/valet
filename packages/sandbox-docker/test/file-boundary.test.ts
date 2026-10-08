import {
  mkdtemp,
  mkdir,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import type { ExecResult } from "@valet/engine";
import { DockerSandbox, DockerSandboxProvider } from "../src/sandbox.js";
const cleanup: string[] = [];
afterEach(async () => {
  for (const root of cleanup.splice(0))
    await rm(root, { recursive: true, force: true });
});
class ContainerOnlySandbox extends DockerSandbox {
  calls: string[] = [];
  override async exec(command: string): Promise<ExecResult> {
    this.calls.push(command);
    return {
      stdout: "",
      stderr: "The target is not mounted in this container.",
      exitCode: 1,
    };
  }
}
it("never follows a workload symlink through the host filesystem for any generic file operation", async () => {
  const root = await mkdtemp(join(tmpdir(), "valet-file-boundary-"));
  cleanup.push(root);
  const workspace = join(root, "workspace");
  await mkdir(workspace);
  const privateDirectory = join(root, "private");
  await mkdir(privateDirectory);
  await writeFile(join(privateDirectory, "secret"), "private-host-state");
  await symlink(privateDirectory, join(workspace, "link"));
  const sandbox = new ContainerOnlySandbox("fixture", {
    containerId: "fixture",
    workspace,
    containerWorkspace: "/workspace",
    image: "alpine",
  });
  for (const operation of [
    () => sandbox.readFile("link/secret"),
    () => sandbox.readBinary("link/secret"),
    () => sandbox.writeFile("link/secret", "changed"),
    () => sandbox.writeBinary("link/secret", new Uint8Array([1])),
    () => sandbox.readdir("link"),
    () => sandbox.stat("link/secret"),
    () => sandbox.mkdir("link/nested"),
    () => sandbox.rm("link/secret"),
  ])
    await expect(operation()).rejects.toThrow();
  expect(await readFile(join(privateDirectory, "secret"), "utf8")).toBe(
    "private-host-state",
  );
  expect(sandbox.calls).toHaveLength(8);
});

it("rejects a working-directory mount that exposes the provider private state tree", async () => {
  const root = await mkdtemp(join(tmpdir(), "valet-overlap-"));
  cleanup.push(root);
  const provider = new DockerSandboxProvider({
    inventoryRoot: join(root, "private"),
  });
  await expect(provider.create({ workspace: root })).rejects.toThrow(
    /overlaps private/,
  );
});
class ExitCodeSandbox extends DockerSandbox {
  constructor(private readonly exitCode: number, workspace: string) {
    super("fixture", { containerId: "fixture", workspace, containerWorkspace: "/workspace", image: "alpine" });
  }
  override async exec(): Promise<ExecResult> {
    return { stdout: "", stderr: "", exitCode: this.exitCode };
  }
}
it("reports a missing path from stat as ENOENT, so callers can tell absence from failure", async () => {
  const root = await mkdtemp(join(tmpdir(), "valet-file-stat-"));
  cleanup.push(root);
  // The upload route checks the destination with stat before it writes, and
  // only an ENOENT-coded error means "free to write". A plain error made
  // every new-file upload on this backend fail.
  await expect(new ExitCodeSandbox(2, root).stat("new.yaml")).rejects.toMatchObject({ code: "ENOENT" });
  await expect(new ExitCodeSandbox(1, root).stat("new.yaml")).rejects.not.toMatchObject({ code: "ENOENT" });
});
