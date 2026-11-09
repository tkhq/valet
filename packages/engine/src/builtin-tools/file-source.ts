import type { SourceInput } from "@valet/shared";
import { shQuote } from "../patch-capture.js";
import type { Sandbox } from "../types.js";

/** Where a sandbox file sits in git, when it sits in a repo. */
export interface FileOrigin {
  /** Repo root in the sandbox. */
  root: string;
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
 * Ask git in the sandbox where a file sits: repo root, HEAD, the `origin`
 * remote, whether the file matches HEAD, and whether a remote branch holds
 * HEAD. One exec. Undefined when the file is outside a repo or git fails.
 */
export async function readFileOrigin(sandbox: Sandbox, path: string, signal?: AbortSignal): Promise<FileOrigin | undefined> {
  const dir = path.slice(0, path.lastIndexOf("/")) || "/";
  const file = shQuote(path);
  const script = [
    `cd ${shQuote(dir)}`,
    "git rev-parse --show-toplevel HEAD",
    "git remote get-url origin 2>/dev/null || echo",
    `{ git ls-files --error-unmatch -- ${file} >/dev/null 2>&1 && git diff --quiet HEAD -- ${file} && echo clean || echo changed; }`,
    "git for-each-ref --contains HEAD --count=1 --format=pushed refs/remotes",
  ].join(" && ");
  try {
    const result = await sandbox.exec(`${script} 2>/dev/null`, { timeout: ORIGIN_TIMEOUT_MS, signal, maxOutputBytes: 8192 });
    if (result.exitCode !== 0) return undefined;
    const [root, sha, remote = "", state, pushed] = result.stdout.split("\n").map(line => line.trim());
    if (!root?.startsWith("/") || !sha || !/^[0-9a-f]{40,64}$/.test(sha)) return undefined;
    const github = githubRepo(remote);
    return { root, sha, ...(github ? { github } : {}), clean: state === "clean", pushed: pushed === "pushed" };
  } catch {
    return undefined;
  }
}

/**
 * The source for the lines the `read` tool returned: `text` holds them,
 * and `firstLine` is the number of the first one. It links to the
 * file on GitHub at HEAD only when GitHub has that commit and the file
 * matches it; otherwise the lines on GitHub could differ from the lines
 * read. Without a link, the location keeps the line range, the commit, and
 * the sandbox path when the title does not already name it.
 */
export function fileSource(path: string, text: string, origin: FileOrigin | undefined, firstLine = 1): SourceInput {
  const lines = text ? text.replace(/\n$/, "").split("\n").length : 0;
  const range = lines > 0 ? `L${firstLine}-L${firstLine + lines - 1}` : undefined;
  const inRepo = origin && (path === origin.root || path.startsWith(`${origin.root}/`)) ? origin : undefined;
  const relative = inRepo ? path.slice(inRepo.root.length + 1) : undefined;
  const repoName = inRepo ? (inRepo.github ?? inRepo.root.split("/").pop() ?? "") : "";
  const title = relative ? `${repoName}/${relative}` : path;
  const at = inRepo ? `at ${inRepo.sha.slice(0, 7)}` : undefined;
  const snippet = text.slice(0, 300);
  if (inRepo?.github && relative && inRepo.clean && inRepo.pushed) {
    const encoded = relative.split("/").map(encodeURIComponent).join("/");
    return {
      service: "github",
      title,
      url: `https://github.com/${inRepo.github}/blob/${inRepo.sha}/${encoded}${range ? `#${range}` : ""}`,
      ...(snippet.trim() ? { snippet } : {}),
      location: [range, at].filter(Boolean).join(" "),
    };
  }
  // The title of a file outside a repo is already its path.
  const location = [[range, at].filter(Boolean).join(" "), relative ? path : ""].filter(Boolean).join(", ");
  return {
    service: "sandbox",
    title,
    ...(snippet.trim() ? { snippet } : {}),
    ...(location ? { location } : {}),
  };
}
