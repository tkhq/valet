import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import { isAbsolute, join } from "node:path";

export interface DockerBrowserCompanion {
  containerName: string;
  containerId?: string;
  image: string;
  imageId?: string;
  /** Exact workload container ID whose network namespace the browser joins. */
  networkOwnerId?: string;
}

export interface DockerInventoryRecord {
  version: 1;
  id: string;
  sessionId: string;
  providerId: string;
  containerName: string;
  containerId?: string;
  workspace: string;
  runtimeStateDir: string;
  /** Retained state from a Docker-only runtime, never mounted into its new browser. */
  workloadStateDir?: string;
  image: string;
  imageId?: string;
  credsHostDir?: string;
  docker: boolean;
  browser?: { enabled: boolean; viewer?: boolean };
  browserCompanion?: DockerBrowserCompanion;
  state: "creating" | "running" | "released";
}
export interface DockerContainerOwner {
  id: string;
  imageId: string;
  labels: Record<string, string>;
  mounts: { source: string; destination: string; readOnly?: boolean }[];
  running: boolean;
  networkMode?: string;
}
function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
function invalid(): never {
  throw new Error(
    "Docker inventory is invalid. Inspect the saved inventory and container ownership before retrying.",
  );
}
function parse(value: unknown): DockerInventoryRecord {
  if (
    !record(value) ||
    value.version !== 1 ||
    typeof value.id !== "string" ||
    typeof value.sessionId !== "string" ||
    typeof value.providerId !== "string" ||
    typeof value.containerName !== "string" ||
    typeof value.workspace !== "string" ||
    typeof value.runtimeStateDir !== "string" ||
    typeof value.image !== "string" ||
    typeof value.docker !== "boolean" ||
    !isAbsolute(value.workspace) ||
    !isAbsolute(value.runtimeStateDir)
  )
    return invalid();
  if (
    value.state !== "creating" &&
    value.state !== "running" &&
    value.state !== "released"
  )
    return invalid();
  for (const key of ["containerId", "imageId", "credsHostDir", "workloadStateDir"])
    if (value[key] !== undefined && typeof value[key] !== "string")
      return invalid();
  let browser: DockerInventoryRecord["browser"];
  if (value.browser !== undefined) {
    if (
      !record(value.browser) ||
      typeof value.browser.enabled !== "boolean" ||
      (value.browser.viewer !== undefined &&
        typeof value.browser.viewer !== "boolean")
    )
      return invalid();
    browser = {
      enabled: value.browser.enabled,
      ...(typeof value.browser.viewer === "boolean"
        ? { viewer: value.browser.viewer }
        : {}),
    };
  }
  let browserCompanion: DockerBrowserCompanion | undefined;
  if (value.browserCompanion !== undefined) {
    const companion = value.browserCompanion;
    if (!record(companion) || !browser?.enabled || !value.docker ||
        typeof companion.containerName !== "string" || typeof companion.image !== "string") return invalid();
    for (const key of ["containerId", "imageId", "networkOwnerId"])
      if (companion[key] !== undefined && typeof companion[key] !== "string") return invalid();
    if (companion.networkOwnerId !== undefined && companion.networkOwnerId !== value.containerId) return invalid();
    if (value.state === "running" && (!value.containerId || !value.imageId || !companion.containerId || !companion.imageId || !companion.networkOwnerId)) return invalid();
    browserCompanion = {
      containerName: companion.containerName,
      image: companion.image,
      ...(typeof companion.containerId === "string" ? { containerId: companion.containerId } : {}),
      ...(typeof companion.imageId === "string" ? { imageId: companion.imageId } : {}),
      ...(typeof companion.networkOwnerId === "string" ? { networkOwnerId: companion.networkOwnerId } : {}),
    };
  }
  return {
    version: 1,
    id: value.id,
    sessionId: value.sessionId,
    providerId: value.providerId,
    containerName: value.containerName,
    workspace: value.workspace,
    runtimeStateDir: value.runtimeStateDir,
    ...(typeof value.workloadStateDir === "string" ? { workloadStateDir: value.workloadStateDir } : {}),
    image: value.image,
    docker: value.docker,
    state: value.state,
    ...(typeof value.containerId === "string"
      ? { containerId: value.containerId }
      : {}),
    ...(typeof value.imageId === "string" ? { imageId: value.imageId } : {}),
    ...(typeof value.credsHostDir === "string"
      ? { credsHostDir: value.credsHostDir }
      : {}),
    ...(browser ? { browser } : {}),
    ...(browserCompanion ? { browserCompanion } : {}),
  };
}
export class DockerInventory {
  constructor(readonly root: string) {}
  private path(id: string): string {
    if (!/^dsb-[a-zA-Z0-9-]+$/.test(id))
      throw new Error(
        "Invalid Docker sandbox identifier. Use the persisted sandbox ID.",
      );
    return join(this.root, "inventory", `${id}.json`);
  }
  async read(id: string): Promise<DockerInventoryRecord | undefined> {
    const file = this.path(id);
    try {
      return parse(JSON.parse(await fs.readFile(file, "utf8")));
    } catch (error) {
      if (record(error) && error.code === "ENOENT") return undefined;
      throw error;
    }
  }
  async reserve(value: DockerInventoryRecord): Promise<boolean> {
    const file = this.path(value.id);
    await fs.mkdir(join(this.root, "inventory"), {
      recursive: true,
      mode: 0o700,
    });
    try {
      const handle = await fs.open(file, "wx", 0o600);
      try {
        await handle.writeFile(JSON.stringify(value));
        await handle.sync();
      } finally {
        await handle.close();
      }
      return true;
    } catch (error) {
      if (record(error) && error.code === "EEXIST") return false;
      throw error;
    }
  }
  async write(value: DockerInventoryRecord): Promise<void> {
    const file = this.path(value.id);
    await fs.mkdir(join(this.root, "inventory"), {
      recursive: true,
      mode: 0o700,
    });
    const temporary = `${file}.${randomUUID()}.tmp`;
    const handle = await fs.open(temporary, "wx", 0o600);
    try {
      await handle.writeFile(JSON.stringify(value));
      await handle.sync();
    } finally {
      await handle.close();
    }
    await fs.rename(temporary, file);
    const directory = await fs.open(join(this.root, "inventory"), "r");
    try {
      await directory.sync();
    } finally {
      await directory.close();
    }
  }
  async remove(id: string): Promise<void> {
    await fs.rm(this.path(id), { force: true });
  }
  async list(): Promise<DockerInventoryRecord[]> {
    let names: string[];
    try {
      names = await fs.readdir(join(this.root, "inventory"));
    } catch (error) {
      if (record(error) && error.code === "ENOENT") return [];
      throw error;
    }
    const values: DockerInventoryRecord[] = [];
    for (const name of names.filter((name) =>
      /^dsb-[a-zA-Z0-9-]+\.json$/.test(name),
    )) {
      const value = await this.read(name.slice(0, -5));
      if (value) values.push(value);
    }
    return values;
  }
}
export function dockerOwnerLabels(
  value: DockerInventoryRecord,
): Record<string, string> {
  return {
    "valet.dev/sandbox-id": value.id,
    "valet.dev/session-id": value.sessionId,
    "valet.dev/provider-id": value.providerId,
    ...(value.browserCompanion ? { "valet.dev/container-role": "workload" } : {}),
    ...(value.browser?.enabled ? { "valet.dev/browser-protocol": "1" } : {}),
  };
}
export function validateDockerOwner(
  expected: DockerInventoryRecord,
  actual: DockerContainerOwner,
): void {
  for (const [key, value] of Object.entries(dockerOwnerLabels(expected)))
    if (actual.labels[key] !== value)
      throw new Error(
        "Docker container owner differs from the saved inventory. Inspect both owners before adopting this container.",
      );
  if (expected.containerId && expected.containerId !== actual.id)
    throw new Error(
      "Docker container identity changed. Restore the recorded container before retrying.",
    );
  if (expected.imageId && expected.imageId !== actual.imageId)
    throw new Error(
      "Docker container image differs from the saved inventory. Inspect the image before restoring the browser profile.",
    );
  if (expected.browserCompanion && actual.mounts.some(mount => mount.source === expected.runtimeStateDir || mount.destination === "/var/lib/valet"))
    throw new Error("Docker workload has a private browser mount. Remove the invalid runtime before replacing this sandbox.");
  for (const [destination, source] of [
    ["/workspace", expected.workspace],
    ...(!expected.browserCompanion ? [["/var/lib/valet", expected.runtimeStateDir]] : []),
    ...(expected.credsHostDir ? [["/etc/valet/creds", expected.credsHostDir]] : []),
  ])
    if (
      !actual.mounts.some(
        (mount) => mount.destination === destination && mount.source === source,
      )
    )
      throw new Error(
        "Docker container mount differs from the saved inventory. Restore the matching session state mount before retrying.",
      );
}
export function dockerBrowserOwnerLabels(value: DockerInventoryRecord): Record<string, string> {
  return { ...dockerOwnerLabels(value), "valet.dev/container-role": "browser" };
}

export function validateDockerBrowserOwner(expected: DockerInventoryRecord, actual: DockerContainerOwner): void {
  const companion = expected.browserCompanion;
  if (!companion) throw new Error("Docker browser companion is missing. Release the runtime before replacing this sandbox.");
  for (const [key, value] of Object.entries(dockerBrowserOwnerLabels(expected)))
    if (actual.labels[key] !== value) throw new Error("Docker browser owner differs from inventory. Inspect both owners before retrying.");
  if (companion.containerId && companion.containerId !== actual.id)
    throw new Error("Docker browser identity changed. Restore the recorded companion before retrying.");
  if (companion.imageId && companion.imageId !== actual.imageId)
    throw new Error("Docker browser image changed. Restore the recorded companion image before retrying.");
  if (!expected.containerId || companion.networkOwnerId !== expected.containerId || actual.networkMode !== `container:${expected.containerId}`)
    throw new Error("Docker browser network owner changed. Release both containers before replacing this sandbox.");
  const privateMount = actual.mounts.find(mount => mount.destination === "/var/lib/valet");
  const workspaceMount = actual.mounts.find(mount => mount.destination === "/workspace");
  if (actual.mounts.length !== 2 || privateMount?.source !== expected.runtimeStateDir || privateMount.readOnly !== false ||
      workspaceMount?.source !== expected.workspace || workspaceMount.readOnly !== true)
    throw new Error("Docker browser mounts differ from inventory. Restore private state and the read-only working-directory mount before retrying.");
}

export function parseDockerInspection(value: unknown): DockerContainerOwner {
  if (!Array.isArray(value) || value.length !== 1 || !record(value[0]))
    return invalid();
  const item = value[0];
  if (
    typeof item.Id !== "string" ||
    typeof item.Image !== "string" ||
    !record(item.Config) ||
    !record(item.Config.Labels) ||
    !record(item.State) ||
    typeof item.State.Running !== "boolean" ||
    !Array.isArray(item.Mounts)
  )
    return invalid();
  const labels: Record<string, string> = {};
  for (const [key, label] of Object.entries(item.Config.Labels)) {
    if (typeof label !== "string") return invalid();
    labels[key] = label;
  }
  const mounts: DockerContainerOwner["mounts"] = [];
  for (const mount of item.Mounts) {
    if (
      !record(mount) ||
      typeof mount.Source !== "string" ||
      typeof mount.Destination !== "string"
    )
      return invalid();
    mounts.push({ source: mount.Source, destination: mount.Destination, ...(typeof mount.RW === "boolean" ? { readOnly: !mount.RW } : {}) });
  }
  return {
    id: item.Id,
    imageId: item.Image,
    labels,
    mounts,
    running: item.State.Running,
    ...(record(item.HostConfig) && typeof item.HostConfig.NetworkMode === "string" ? { networkMode: item.HostConfig.NetworkMode } : {}),
  };
}
