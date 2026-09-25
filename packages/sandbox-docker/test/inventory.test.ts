import {
  mkdtemp,
  mkdir,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import {
  DockerInventory,
  type DockerInventoryRecord,
  validateDockerOwner,
} from "../src/inventory.js";
let root: string;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "valet-inventory-"));
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});
function record(): DockerInventoryRecord {
  return {
    version: 1,
    id: "dsb-session",
    sessionId: "session",
    providerId: "daemon",
    containerName: "valet-dsb-session",
    containerId: "container",
    workspace: "/work",
    runtimeStateDir: join(root, "state"),
    image: "image:1",
    imageId: "sha256:image",
    docker: false,
    state: "running",
  };
}
it("restores durable inventory from another instance and keeps it private", async () => {
  const first = new DockerInventory(root);
  await first.write(record());
  expect(await new DockerInventory(root).read("dsb-session")).toEqual(record());
  expect(
    (await stat(join(root, "inventory/dsb-session.json"))).mode & 0o777,
  ).toBe(0o600);
});
it("rejects malformed inventory and traversal without deleting recovery evidence", async () => {
  const inventory = new DockerInventory(root);
  await mkdir(join(root, "inventory"));
  await writeFile(join(root, "inventory/dsb-bad.json"), '{"version":1}');
  await expect(inventory.read("../outside")).rejects.toThrow(/identifier/i);
  await expect(inventory.read("dsb-bad")).rejects.toThrow(/inventory/i);
  expect(await readFile(join(root, "inventory/dsb-bad.json"), "utf8")).toBe(
    '{"version":1}',
  );
});
it("rejects containers with a changed owner, image or mount", () => {
  const expected = record();
  const actual = {
    id: "container",
    imageId: "sha256:image",
    labels: {
      "valet.dev/sandbox-id": "dsb-session",
      "valet.dev/session-id": "session",
      "valet.dev/provider-id": "daemon",
      "valet.dev/browser-protocol": "1",
    },
    mounts: [
      { source: "/work", destination: "/workspace" },
      { source: expected.runtimeStateDir, destination: "/var/lib/valet" },
    ],
    running: true,
  };
  expect(() => validateDockerOwner(expected, actual)).not.toThrow();
  expect(() =>
    validateDockerOwner(expected, {
      ...actual,
      labels: { ...actual.labels, "valet.dev/session-id": "other" },
    }),
  ).toThrow(/owner/i);
  expect(() =>
    validateDockerOwner(expected, { ...actual, imageId: "sha256:changed" }),
  ).toThrow(/image/i);
  expect(() =>
    validateDockerOwner(expected, { ...actual, mounts: [] }),
  ).toThrow(/mount/i);
});
it("reserves each owner once across independent provider instances", async () => {
  const outcomes = await Promise.all([
    new DockerInventory(root).reserve(record()),
    new DockerInventory(root).reserve(record()),
  ]);
  expect(outcomes.filter(Boolean)).toHaveLength(1);
  expect(await new DockerInventory(root).read("dsb-session")).toEqual(record());
});
