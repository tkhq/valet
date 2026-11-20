/**
 * Host directories the Docker backend must never bind as a sandbox's
 * read-write working directory. The bind gives the sandbox, and anything that
 * runs in it, the host's files at that path: binding `/` let a sandbox's
 * setup re-own the whole host.
 */
import { isAbsolute, relative } from "node:path";

/** System trees on a Docker host. A working directory inside one is refused. */
const SYSTEM_TREES = [
  "/etc", "/usr", "/bin", "/sbin", "/lib", "/lib32", "/lib64", "/libx32", "/boot",
  "/proc", "/sys", "/dev", "/run", "/var/run", "/var/lib/docker", "/var/lib/containerd",
];

/** True when `path` equals `root` or is below it. */
function within(path: string, root: string): boolean {
  const rel = relative(root, path);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

/** Host paths a working directory must keep clear of. */
export interface HostWorkspaceGuards {
  /** Paths the sandbox must not reach: not equal to, inside, or containing the working directory. */
  privatePaths: readonly string[];
  /** Roots a working directory may sit inside but must not equal or contain, such as Valet's data directory. */
  dataRoots: readonly string[];
  /**
   * When set, the only roots a working directory may sit inside (strictly).
   * The api passes Valet's own working-directory roots, so a path from any
   * other source is refused even when the checks below would allow it.
   */
  allowedRoots?: readonly string[];
}

/**
 * The refusal for a resolved (realpath'd) host working directory, or null
 * when it is safe to bind read-write into a sandbox.
 */
export function hostWorkspaceRefusal(workspace: string, guards: HostWorkspaceGuards): string | null {
  if (workspace.split("/").filter(Boolean).length < 2) {
    return "The Docker working directory is the host root or a top-level host directory. Select a directory at least two levels deep.";
  }
  const tree = SYSTEM_TREES.find((root) => within(workspace, root));
  if (tree) return `The Docker working directory is inside the host system directory ${tree}. Select a directory outside system paths.`;
  const overlapsPrivate = guards.privatePaths.some((path) => within(path, workspace) || within(workspace, path));
  const holdsData = guards.dataRoots.some((root) => within(root, workspace));
  if (overlapsPrivate || holdsData) {
    return "The working directory overlaps private Valet or Docker session state. Select a separate working directory before creating this sandbox.";
  }
  if (guards.allowedRoots && !guards.allowedRoots.some((root) => workspace !== root && within(workspace, root))) {
    return `The Docker working directory is outside Valet's working-directory roots (${guards.allowedRoots.join(", ")}). Create the session through Valet so it gets a directory under one of them.`;
  }
  return null;
}
