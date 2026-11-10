import type { SourceInput } from "@valet/shared";
import { shQuote } from "../patch-capture.js";
import type { Sandbox } from "../types.js";

/** Where a sandbox file sits in git, when it sits in a repo. */
export interface FileOrigin {
  /** Repo root, as the sandbox names it. */
  root: string;
  /** The file's path from the repo root. */
  relative: string;
  /** Full HEAD commit. */
  sha: string;
  /** `owner/repo` when `origin` is a github.com remote. */
  github?: string;
  /** The file is tracked and has no change against HEAD. */
  clean: boolean;
  /** A remote-tracking branch contains HEAD, so GitHub has the commit. */
  pushed: boolean;
}

/** A slow or stuck git must not hold up a file read for long. */
const ORIGIN_TIMEOUT_MS = 5_000;

/** `owner/repo` from a github.com remote URL in any of its forms. Credentials in the URL are never kept. */
export function githubRepo(remote: string): string | undefined {
  const match = /^(?:https?:\/\/(?:[^@/]+@)?|ssh:\/\/git@|git@)github\.com[:/]([\w.-]+)\/([\w.-]+?)(?:\.git)?\/?$/i.exec(remote.trim());
  return match ? `${match[1]}/${match[2]}` : undefined;
}

/**
 * Ask git in the sandbox where a file sits: repo root, the file's path in
 * the repo, HEAD, the `origin` remote, whether the file matches HEAD, and
 * whether a remote branch holds HEAD. One exec. `path` is the path the
 * tool got: the exec resolves a relative path from the sandbox working
 * directory, as the read does. The host's name for the working directory
 * can differ from the sandbox's (Docker binds it to `/workspace`), so the
 * exec never gets a host path. Undefined when the file is outside a repo
 * or git fails.
 */
export async function readFileOrigin(sandbox: Sandbox, path: string, signal?: AbortSignal): Promise<FileOrigin | undefined> {
  const slash = path.lastIndexOf("/");
  const dir = slash < 0 ? "." : path.slice(0, slash) || "/";
  const name = path.slice(slash + 1);
  if (!name) return undefined;
  const file = shQuote(name);
  // The exec user can differ from the clone's owner. These reads change
  // nothing, so git may read a repo that another user owns.
  const git = "git -c safe.directory='*'";
  const script = [
    `cd ${shQuote(dir)}`,
    `${git} rev-parse --show-toplevel --show-prefix HEAD`,
    `{ ${git} remote get-url origin 2>/dev/null || echo; }`,
    `{ ${git} ls-files --error-unmatch -- ${file} >/dev/null 2>&1 && ${git} diff --quiet HEAD -- ${file} && echo clean || echo changed; }`,
    `${git} for-each-ref --contains HEAD --count=1 --format=pushed refs/remotes`,
  ].join(" && ");
  try {
    const result = await sandbox.exec(`${script} 2>/dev/null`, { timeout: ORIGIN_TIMEOUT_MS, signal, maxOutputBytes: 8192 });
    if (result.exitCode !== 0) return undefined;
    const [root, prefix = "", sha, remote = "", state, pushed] = result.stdout.split("\n").map(line => line.trim());
    if (!root?.startsWith("/") || !sha || !/^[0-9a-f]{40,64}$/.test(sha)) return undefined;
    const github = githubRepo(remote);
    return { root, relative: `${prefix}${name}`, sha, ...(github ? { github } : {}), clean: state === "clean", pushed: pushed === "pushed" };
  } catch {
    return undefined;
  }
}

/**
 * The source for the lines the `read` tool returned: `text` holds them,
 * and `firstLine` is the number of the first one. `path` is the path the
 * tool got. It links to the file on GitHub at HEAD only when GitHub has
 * that commit and the file matches it; otherwise the lines on GitHub could
 * differ from the lines read. Without a link, the location keeps the line
 * range, the commit, and the file's sandbox path when the title does not
 * already name it.
 */
export function fileSource(path: string, text: string, origin: FileOrigin | undefined, firstLine = 1): SourceInput {
  const lines = text ? text.replace(/\n$/, "").split("\n").length : 0;
  const range = lines > 0 ? `L${firstLine}-L${firstLine + lines - 1}` : undefined;
  const repoName = origin ? (origin.github ?? origin.root.split("/").pop() ?? "") : "";
  const title = origin ? `${repoName}/${origin.relative}` : path;
  const at = origin ? `at ${origin.sha.slice(0, 7)}` : undefined;
  const snippet = text.slice(0, 300);
  if (origin?.github && origin.clean && origin.pushed) {
    const encoded = origin.relative.split("/").map(encodeURIComponent).join("/");
    return {
      service: "github",
      title,
      url: `https://github.com/${origin.github}/blob/${origin.sha}/${encoded}${range ? `#${range}` : ""}`,
      ...(snippet.trim() ? { snippet } : {}),
      location: [range, at].filter(Boolean).join(" "),
    };
  }
  const location = [[range, at].filter(Boolean).join(" "), origin ? `${origin.root}/${origin.relative}` : ""].filter(Boolean).join(", ");
  return {
    service: "sandbox",
    title,
    ...(snippet.trim() ? { snippet } : {}),
    ...(location ? { location } : {}),
  };
}
