/** Selected home state shares the workspace PVC. See TKAI-427. */
import type { SandboxContainer, VolumeMount } from "./types.js";
import { shQuote } from "./exec.js";

export const HOME_VOLUME_ROOT = "/var/lib/valet/home";
export const STORAGE_SUBPATH = ".valet-storage";
export const WORKSPACE_SUBPATH = `${STORAGE_SUBPATH}/workspace`;
const INIT_VOLUME_ROOT = "/valet-volume";
export const HOME_LAYOUT_ENV = "VALET_HOME_LAYOUT_VERSION";
export const HOME_LAYOUT_VERSION = "1";
export const HOME_INIT_NAME = "valet-home-init";
export const HOME_DIRECTORIES = [".config", ".cache", ".local", ".ssh", ".npm", ".cargo", ".rustup", ".bun", ".nvm", "go", ".gradle", ".m2"];
const HOME_FILES = [".gitconfig", ".git-credentials", ".npmrc", ".bashrc", ".profile"];
export interface PersistentHome { name: string; path: string; uid: number; gid: number }
export const PERSISTENT_HOMES: PersistentHome[] = [
  { name: "root", path: "/root", uid: 0, gid: 0 },
  { name: "dockerd", path: "/home/dockerd", uid: 1500, gid: 1500 },
];

/** Seed only absent paths. Existing user state wins over image defaults. */
export function homeInitScript(homes = PERSISTENT_HOMES, root = HOME_VOLUME_ROOT): string {
  return `set -eu
trap 'echo "Home persistence setup failed. Check the sandbox volume permissions and free space, then retry." >&2' 0
root=${shQuote(root)}
[ ! -L "$root" ]
mkdir -p "$root"
chmod 755 "$root"
${homes.map((home) => `base=${shQuote(`${root}/${home.name}`)}
[ ! -L "$base" ]
mkdir -p "$base"
chmod 700 "$base"
chown ${home.uid}:${home.gid} "$base"
${[...HOME_DIRECTORIES, ...HOME_FILES].map((entry) => {
    const directory = HOME_DIRECTORIES.includes(entry);
    return `dest=${shQuote(`${root}/${home.name}/${entry}`)}
source=${shQuote(`${home.path}/${entry}`)}
[ ! -L "$dest" ]
if [ ! -e "$dest" ]; then
  stage="$dest.seed"
  [ ! -L "$stage" ]
  ${directory ? 'mkdir -p "$stage"' : ': > "$stage"'}
  if [ -e "$source" ]; then
    ${directory ? 'cp -a "$source/." "$stage/"' : 'cp "$source" "$stage"'}
  fi
  chown -R ${home.uid}:${home.gid} "$stage"
  chmod ${directory ? "700" : "600"} "$stage"
  mv "$stage" "$dest"
fi
${entry === ".ssh" ? 'chmod -R go-rwx "$dest"' : ""}`;
  }).join("\n")}`).join("\n")}
trap - 0
`;
}

/** File symlinks allow Git's lock-and-rename writes, unlike file bind mounts. */
export function homeLinkScript(homes = PERSISTENT_HOMES, root = HOME_VOLUME_ROOT): string {
  return `set -eu
${homes.map((home) => `mkdir -p ${shQuote(home.path)}
${HOME_FILES.map((entry) => `ln -sfn ${shQuote(`${root}/${home.name}/${entry}`)} ${shQuote(`${home.path}/${entry}`)}`).join("\n")}`).join("\n")}
`;
}

export function persistentHomeMounts(): VolumeMount[] {
  return [{ name: "workspace", mountPath: HOME_VOLUME_ROOT, subPath: `${STORAGE_SUBPATH}/home` }, ...PERSISTENT_HOMES.flatMap((home) => HOME_DIRECTORIES.map((entry) => ({
    name: "workspace", mountPath: `${home.path}/${entry}`, subPath: `${STORAGE_SUBPATH}/home/${home.name}/${entry}`,
  })))];
}

export function homeInitContainer(image: string): SandboxContainer {
  return { name: HOME_INIT_NAME, image, command: ["sh", "-c", migrateWorkspaceScript() + homeInitScript(PERSISTENT_HOMES, `${INIT_VOLUME_ROOT}/${STORAGE_SUBPATH}/home`)],
    volumeMounts: [{ name: "workspace", mountPath: INIT_VOLUME_ROOT }] };
}

export function withHomeLinks(command: string[]): string[] {
  return ["sh", "-c", `${homeLinkScript()}exec "$@"`, "valet-home-start", ...command];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Upgrade retained templates without dropping unrelated pod configuration. */
export function withPersistentHomes(template: unknown): Record<string, unknown> {
  if (!isRecord(template) || !isRecord(template.spec) || !Array.isArray(template.spec.containers)) {
    throw new Error("Sandbox pod template is invalid. Repair the sandbox definition before resuming.");
  }
  const sandbox = template.spec.containers.find((c: unknown) => isRecord(c) && c.name === "sandbox");
  if (!isRecord(sandbox) || typeof sandbox.image !== "string" || !Array.isArray(sandbox.command) ||
      !sandbox.command.every((part: unknown) => typeof part === "string")) {
    throw new Error("Sandbox startup command is missing. Recreate the sandbox definition before resuming.");
  }
  const command: string[] = sandbox.command;
  const original = command[3] === "valet-home-start" ? command.slice(4) : command;
  const mounts: unknown[] = Array.isArray(sandbox.volumeMounts) ? sandbox.volumeMounts : [];
  const homeMounts = persistentHomeMounts();
  const homePaths = new Set([...homeMounts.map((mount) => mount.mountPath), "/workspace"]);
  const env: unknown[] = Array.isArray(sandbox.env) ? sandbox.env : [];
  const upgraded = { ...sandbox, env: [...env.filter((entry) => !isRecord(entry) || entry.name !== HOME_LAYOUT_ENV),
    { name: HOME_LAYOUT_ENV, value: HOME_LAYOUT_VERSION }], command: withHomeLinks(original), volumeMounts: [
    { name: "workspace", mountPath: "/workspace", subPath: WORKSPACE_SUBPATH },
    ...homeMounts,
    ...mounts.filter((mount) => !isRecord(mount) || !homePaths.has(String(mount.mountPath))),
  ] };
  const init: unknown[] = Array.isArray(template.spec.initContainers) ? template.spec.initContainers : [];
  return { ...template, spec: { ...template.spec,
    containers: template.spec.containers.map((container: unknown) => container === sandbox ? upgraded : container),
    initContainers: [homeInitContainer(sandbox.image), ...init.filter((container) => !isRecord(container) || container.name !== HOME_INIT_NAME)],
  } };
}

/** Move legacy PVC contents once while no workload container can access them.
 * The progress marker permits retry after an interrupted init container. */
export function migrateWorkspaceScript(root = INIT_VOLUME_ROOT): string {
  return `set -eu
root=${shQuote(root)}
storage="$root/${STORAGE_SUBPATH}"
# Inherit the PVC fsGroup so workload-user execs can write new repositories.
chmod g+s "$root"
if [ -e "$storage" ] || [ -L "$storage" ]; then
  # An empty directory is the crash window before the progress marker write.
  if [ ! -L "$storage" ] && [ -d "$storage" ] && [ -z "$(ls -A "$storage")" ]; then
    : > "$storage/migrating-v1"
  fi
  if [ -L "$storage" ] || [ ! -d "$storage" ] || { [ ! -f "$storage/layout-v1" ] && [ ! -f "$storage/migrating-v1" ]; }; then
    echo "Reserved sandbox storage path is occupied. Move .valet-storage out of the volume root, then retry." >&2
    exit 1
  fi
else
  mkdir "$storage"
  : > "$storage/migrating-v1"
fi
if [ ! -f "$storage/layout-v1" ]; then
  [ ! -L "$storage/workspace" ]
  mkdir -p "$storage/workspace"
  chmod 2775 "$storage" "$storage/workspace"
  for entry in "$root"/.[!.]* "$root"/..?* "$root"/*; do
    [ -e "$entry" ] || [ -L "$entry" ] || continue
    [ "$entry" != "$storage" ] || continue
    name=$(basename "$entry")
    if [ -e "$storage/workspace/$name" ] || [ -L "$storage/workspace/$name" ]; then
      echo "Sandbox storage migration found conflicting files. Resolve the volume conflict, then retry." >&2
      exit 1
    fi
    mv "$entry" "$storage/workspace/"
  done
  mv "$storage/migrating-v1" "$storage/layout-v1"
fi
`;
}
