/**
 * `pull_request` cases on private repos. The case file holds only the
 * remote, the commits, the title and the golden comments; the code and the
 * description come from the remote at run time. A runner without read
 * access to the remote SKIPs the case instead of failing it.
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const run = promisify(execFile);

/** One probe per remote per process: every case of a repo shares the answer. */
const probes = new Map<string, Promise<string | undefined>>();

/**
 * Undefined when this machine can read `remote`, else the SKIP reason.
 * Uses the git credentials the runner already has; it never prompts.
 */
export function privateRemoteDenied(remote: string): Promise<string | undefined> {
  let probe = probes.get(remote);
  if (probe === undefined) {
    probe = run("git", ["ls-remote", "--exit-code", remote, "HEAD"], {
      timeout: 30_000,
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
    }).then(
      () => undefined,
      () => `no read access to ${remote}. Sign in to GitHub with an account that can read it (gh auth login), then run again.`,
    );
    probes.set(remote, probe);
  }
  return probe;
}

/** `owner/name` of a github.com remote URL, or undefined for any other host. */
export function githubRepo(remote: string): string | undefined {
  const m = /^(?:https:\/\/github\.com\/|git@github\.com:)([^/]+\/[^/]+?)(?:\.git)?\/?$/.exec(remote);
  return m?.[1];
}

/**
 * The pull request's description from GitHub through the `gh` CLI. Empty
 * when the remote is not on github.com or the read fails: the review then
 * runs on the title alone, and the reason goes to stderr.
 */
export async function pullRequestBody(remote: string, number: number): Promise<string> {
  const repo = githubRepo(remote);
  if (repo === undefined) return "";
  try {
    const { stdout } = await run("gh", ["api", `repos/${repo}/pulls/${number}`, "--jq", ".body // \"\""], { timeout: 30_000 });
    return stdout.replace(/\n$/, "");
  } catch (err) {
    process.stderr.write(`could not read the description of ${repo}#${number}; reviewing on the title alone: ${err instanceof Error ? err.message : String(err)}\n`);
    return "";
  }
}
