import { spawnSync } from "node:child_process";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  createSandboxWorkspace,
  DockerSandboxProvider,
} from "../src/sandbox.js";
const available =
  spawnSync("docker", ["version", "--format", "{{.Server.Version}}"], {
    stdio: "pipe",
  }).status === 0;
describe.skipIf(!available)("durable Docker ownership", () => {
  it("runs portable file operations in Alpine and cannot follow symlinks into host-private state", async () => {
    const root = await createSandboxWorkspace("valet-portable-files-");
    const workspace = join(root, "workspace");
    await mkdir(workspace);
    const privateFile = join(root, "host-secret");
    await writeFile(privateFile, "private-host-state");
    const provider = new DockerSandboxProvider({
      inventoryRoot: join(root, "inventory"),
    });
    const sandbox = await provider.create({ workspace, image: "alpine:3.20" });
    try {
      await sandbox.mkdir("nested");
      await sandbox.writeFile("nested/text", "portable");
      expect(await sandbox.readFile("nested/text")).toBe("portable");
      const bytes = new Uint8Array([0, 255, 128, 10]);
      await sandbox.writeBinary("nested/data", bytes);
      expect(await sandbox.readBinary("nested/data")).toEqual(bytes);
      expect(await sandbox.stat("nested/text")).toEqual({
        isFile: true,
        isDirectory: false,
        size: 8,
      });
      expect((await sandbox.stat("nested")).isDirectory).toBe(true);
      await sandbox.writeFile(".hidden", "hidden");
      await sandbox.writeFile("line\nbreak", "newline");
      expect(await sandbox.readdir(".")).toEqual(
        expect.arrayContaining([".hidden", "line\nbreak", "nested"]),
      );
      await sandbox.exec(`ln -s '${privateFile}' /workspace/host-link`);
      await expect(sandbox.readFile("host-link")).rejects.toThrow();
      await expect(sandbox.writeFile("host-link", "changed")).rejects.toThrow();
      expect(await readFile(privateFile, "utf8")).toBe("private-host-state");
      await sandbox.rm("nested", { recursive: true });
      await expect(sandbox.stat("nested")).rejects.toThrow();
    } finally {
      await provider.destroy(sandbox.id);
      await rm(root, { recursive: true, force: true });
    }
  });
  it.skipIf(!process.env.VALET_BROWSER_TEST_IMAGE)(
    "separates workload access from private browser state across exec and file APIs",
    async () => {
      const root = await createSandboxWorkspace("valet-browser-identity-");
      const workspace = join(root, "workspace");
      await mkdir(workspace);
      const provider = new DockerSandboxProvider({
        browserEnabled: true,
        inventoryRoot: join(root, "private"),
      });
      const sandbox = await provider.create({
        workspace,
        sessionId: `identity-${root.split("/").at(-1)}`,
        image: process.env.VALET_BROWSER_TEST_IMAGE,
        browser: { enabled: true },
        env: { VALET_SANDBOX_JWT_SECRET: "fixture-signing-secret" },
      });
      try {
        expect((await sandbox.exec("id -u")).stdout.trim()).toBe("1500");
        expect(
          (
            await sandbox.exec(
              "printf '%s' \"${VALET_SANDBOX_JWT_SECRET:-unset}\"",
            )
          ).stdout,
        ).toBe("unset");
        await sandbox.writeFile("test.txt", "host-api");
        expect(
          (await sandbox.exec("cat test.txt && printf changed > test.txt"))
            .stdout,
        ).toBe("host-api");
        expect(await sandbox.readFile("test.txt")).toBe("changed");
        expect(
          (await sandbox.exec("mkdir nested && printf nested > nested/entry"))
            .exitCode,
        ).toBe(0);
        await sandbox.writeFile("nested/entry", "file-api-change");
        expect((await sandbox.exec("cat nested/entry")).stdout).toBe(
          "file-api-change",
        );
        expect(
          (await sandbox.exec("cat /var/lib/valet/browser/journal.sqlite"))
            .exitCode,
        ).not.toBe(0);
        expect(
          (
            await sandbox.exec("/usr/local/bin/valet-browser-client", {
              stdin: "{}",
            })
          ).exitCode,
        ).not.toBe(0);
        await sandbox.exec("ln -s /var/lib/valet/browser private-link");
        await expect(
          sandbox.readFile("private-link/journal.sqlite"),
        ).rejects.toThrow();
        const status = await sandbox.exec(
          "/usr/local/bin/valet-browser-client",
          {
            privileged: true,
            stdin: JSON.stringify({
              protocolVersion: "1.0",
              sessionId: `identity-${root.split("/").at(-1)}`,
              threadId: "thread",
              actorId: "actor",
              ownerId: "actor",
              command: "status",
            }),
          },
        );
        if (status.exitCode !== 0)
          console.error(
            status,
            await sandbox.exec("cat /var/lib/valet/browser/daemon.log", {
              privileged: true,
            }),
          );
        expect(status.exitCode).toBe(0);
        expect(status.stdout).toContain('"state":"ready"');
        expect(
          (
            await sandbox.exec(
              'node -e \'require("net").connect("/var/lib/valet/browser/control.sock").on("error",()=>process.exit(7))\'',
            )
          ).exitCode,
        ).not.toBe(0);
      } finally {
        await provider.destroy(sandbox.id);
        await rm(root, { recursive: true, force: true });
      }
    },
  );
  it("adopts the live container after API restart, retains state on replacement and deletes it only at session deletion", async () => {
    const root = await createSandboxWorkspace("valet-durable-");
    const workspace = join(root, "workspace");
    await mkdir(workspace);
    const config = { inventoryRoot: join(root, "private") };
    const opts = {
      workspace,
      image: "alpine:3.20",
      sessionId: `session-${root.split("/").at(-1)}`,
    };
    const first = new DockerSandboxProvider(config);
    const sandbox = await first.create(opts);
    const restarted = new DockerSandboxProvider(config);
    try {
      await sandbox.exec(
        "mkdir -p /var/lib/valet/browser/profile && printf signed-in > /var/lib/valet/browser/profile/cookie",
      );
      const originalHostname = (await sandbox.exec("hostname")).stdout;
      const adopted = await restarted.restore(sandbox.id);
      expect(
        (await adopted.exec("cat /var/lib/valet/browser/profile/cookie"))
          .stdout,
      ).toBe("signed-in");
      expect((await adopted.exec("hostname")).stdout).toBe(
        (await sandbox.exec("hostname")).stdout,
      );
      await restarted.release(sandbox.id);
      const replacement = await restarted.create(opts);
      expect(
        (await replacement.exec("cat /var/lib/valet/browser/profile/cookie"))
          .stdout,
      ).toBe("signed-in");
      expect((await replacement.exec("hostname")).stdout).not.toBe(
        originalHostname,
      );
      const inventory = JSON.parse(
        await readFile(
          join(config.inventoryRoot, "inventory", sandbox.id + ".json"),
          "utf8",
        ),
      );
      await restarted.destroy(replacement.id);
      await expect(
        readFile(join(inventory.runtimeStateDir, "browser/profile/cookie")),
      ).rejects.toThrow();
    } finally {
      await restarted.destroy(sandbox.id);
      await first.destroy(sandbox.id);
      await rm(root, { recursive: true, force: true });
    }
  });
});
