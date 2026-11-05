import { createHash } from "node:crypto";
import {
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  DockerInventory,
  type DockerInventoryRecord,
} from "../src/inventory.js";
import {
  DockerSandboxProvider,
  type DockerSandboxCreateOpts,
} from "../src/sandbox.js";

let root: string;
beforeEach(async () => {
  root = await realpath(
    await mkdtemp(join(tmpdir(), "valet-browser-downgrade-")),
  );
  const bin = join(root, "bin");
  await mkdir(bin);
  await writeFile(
    join(bin, "docker"),
    `#!/bin/sh
if [ "$1" = info ]; then
  printf 'fixture-daemon\\n'
  exit 0
fi
printf '%s\\n' "$1" >> '${root}/unexpected-docker-calls'
printf 'Unexpected Docker operation\\n' >&2
exit 125
`,
    { mode: 0o755 },
  );
  vi.stubEnv("PATH", bin);
});
afterEach(async () => {
  vi.unstubAllEnvs();
  await rm(root, { recursive: true, force: true });
});

it.each([undefined, { enabled: false }])(
  "rejects a released browser owner's downgrade to %j without changing retained state",
  async (browser) => {
    const workspace = join(root, "workspace");
    await mkdir(workspace);
    const inventoryRoot = join(root, "private");
    const inventory = new DockerInventory(inventoryRoot);
    const sessionId = "retained-browser-session";
    const id = `dsb-${createHash("sha256").update(sessionId).digest("hex").slice(0, 32)}`;
    const runtimeStateDir = join(inventoryRoot, "state", id);
    await mkdir(runtimeStateDir, { recursive: true });
    await writeFile(
      join(runtimeStateDir, "profile-marker"),
      "private browser state",
    );
    const saved: DockerInventoryRecord = {
      version: 1,
      id,
      sessionId,
      providerId: "fixture-daemon",
      containerName: `valet-sandbox-${id}`,
      workspace,
      runtimeStateDir,
      image: "fixture:browser",
      docker: false,
      browser: { enabled: true, viewer: true },
      state: "released",
    };
    await inventory.write(saved);
    const provider = new DockerSandboxProvider({ inventoryRoot });
    const options: DockerSandboxCreateOpts = {
      sessionId,
      workspace,
      image: saved.image,
      pullIfMissing: false,
      browser,
    };

    await expect(provider.create(options)).rejects.toThrow(
      /retained browser state.*re-enable browser isolation/i,
    );
    expect(await inventory.read(id)).toEqual(saved);
    expect(
      await readFile(join(runtimeStateDir, "profile-marker"), "utf8"),
    ).toBe("private browser state");
    await expect(
      readFile(join(root, "unexpected-docker-calls")),
    ).rejects.toMatchObject({ code: "ENOENT" });
  },
);
