/**
 * Where a client-created session's working directory lives on the api host.
 *
 * `POST /api/sessions` used to store the client's absolute path as the
 * working directory, and the Docker backend bind-mounts it read-write into
 * the sandbox. A path such as `/` gave a session the host's own files, and a
 * path another person's session used gave that person's files. The server now
 * builds the directory itself: `<root>/<userId>/<name>`, where `name` is the
 * last segment of the requested path. A client cannot name a directory
 * outside its own.
 *
 * `VALET_WORKSPACE_ROOT` (an absolute path at least two levels deep) replaces
 * the default `~/.valet/workspaces`. Server-made working directories
 * (assistants, children, workflows) do not pass through here.
 */
import { realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, isAbsolute, join, relative, resolve } from "node:path";

/** The root for client-created working directories. Throws when the configured root is unsafe. */
export function clientWorkspaceRoot(env: Record<string, string | undefined> = process.env): string {
  const configured = env.VALET_WORKSPACE_ROOT?.trim();
  if (!configured) return join(homedir(), ".valet", "workspaces");
  const root = resolve(configured);
  if (!isAbsolute(configured) || root.split("/").filter(Boolean).length < 2) {
    throw new Error("VALET_WORKSPACE_ROOT must be an absolute directory at least two levels deep, such as /var/lib/valet/workspaces. Fix the setting and restart the api.");
  }
  return root;
}

/** One safe path segment: letters, digits, dot, dash, and underscore, never "." or "..". */
function segment(value: string, fallback: string): string {
  const cleaned = value.replace(/[^A-Za-z0-9._-]/g, "-").replace(/^\.+/, "").slice(0, 100);
  return cleaned === "" || cleaned === "-" ? fallback : cleaned;
}

/** The working directory the server builds for `userId` from a requested path's last segment. */
export function clientWorkspacePath(root: string, userId: string, requested: string): string {
  return join(root, segment(userId, "user"), segment(basename(requested), "workspace"));
}

/** True when `path` is strictly below `parent`: a directory never contains itself. */
export function isStrictlyInside(path: string, parent: string): boolean {
  const rel = relative(parent, path);
  return rel !== "" && !rel.startsWith("..") && !isAbsolute(rel);
}

/**
 * The refusal for a built working directory whose real path leaves the
 * caller's own directory, for example through a symlink. Run it after the
 * directory exists.
 */
export async function workspaceRealpathRefusal(workspace: string, userDir: string): Promise<string | null> {
  const real = await realpath(workspace);
  const realUserDir = await realpath(userDir).catch(() => userDir);
  if (isStrictlyInside(real, realUserDir)) return null;
  return `workspace resolves to ${real}, outside your working-directory root. Remove the link and create the session again.`;
}
