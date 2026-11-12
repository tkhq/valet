/**
 * `pull_request` cases on private repos, and suites kept outside this repo.
 *
 * A private case file holds only the remote, the commits, the title and the
 * golden comments; the code and the description come from the remote at
 * run time. A runner without read access to the remote SKIPs the case. Any
 * other failure (network, a missing `git` or `gh`, a bad commit) fails it.
 *
 * Suites whose cases name private repositories are not committed here. They
 * live in a directory named by `VALET_EVAL_PRIVATE_CASES`, and the CLI loads
 * one with `--cases private:<suite>`.
 */
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);

export const PRIVATE_CASES_ENV = "VALET_EVAL_PRIVATE_CASES";
const PRIVATE_PREFIX = "private:";

/** Git and GitHub messages that mean "this account cannot read the repo", as opposed to an error. */
const NO_ACCESS =
  /repository not found|could not read username|terminal prompts disabled|authentication failed|permission denied|access denied|requested url returned error: 40[134]|HTTP 40[134]|Not Found \(HTTP 404\)/i;

export type RemoteAccess = { kind: "ok" } | { kind: "denied"; reason: string } | { kind: "error"; message: string };

/** One probe per remote per process: every case of a repo shares the answer. */
const probes = new Map<string, Promise<RemoteAccess>>();

function stderrOf(err: unknown): string {
  if (typeof err === "object" && err !== null && "stderr" in err && typeof err.stderr === "string" && err.stderr.trim()) return err.stderr.trim();
  return err instanceof Error ? err.message : String(err);
}

/**
 * Whether this machine can read `remote`, using the git credentials the
 * runner already has. It never prompts.
 */
export function privateRemoteAccess(remote: string): Promise<RemoteAccess> {
  let probe = probes.get(remote);
  if (probe === undefined) {
    probe = run("git", ["ls-remote", "--exit-code", remote, "HEAD"], {
      timeout: 30_000,
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
    }).then(
      (): RemoteAccess => ({ kind: "ok" }),
      (err: unknown): RemoteAccess => {
        const detail = stderrOf(err);
        return NO_ACCESS.test(detail) || /does not appear to be a git repository|does not exist/i.test(detail)
          ? { kind: "denied", reason: `no read access to ${remote}. Sign in to GitHub with an account that can read it (gh auth login), then run again.` }
          : { kind: "error", message: `could not check access to ${remote}: ${detail}` };
      },
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
 * when the remote is not on github.com. A failed read throws, so the case
 * fails instead of running a review without the description.
 */
export async function pullRequestBody(remote: string, number: number): Promise<string> {
  const repo = githubRepo(remote);
  if (repo === undefined) return "";
  try {
    const { stdout } = await run("gh", ["api", `repos/${repo}/pulls/${number}`, "--jq", ".body // \"\""], { timeout: 30_000 });
    return stdout.replace(/\n$/, "");
  } catch (err) {
    throw new Error(`could not read the description of ${repo}#${number} with gh: ${stderrOf(err)}. Check gh auth status, then run again.`);
  }
}

/**
 * `--cases private:<suite>` → the suite directory under
 * `VALET_EVAL_PRIVATE_CASES`. `skip` says why the suite cannot run here.
 * Any other `--cases` value passes through unchanged.
 */
export function resolvePrivateCases(cases: string, env: NodeJS.ProcessEnv = process.env): { dir: string } | { skip: string } | undefined {
  if (!cases.startsWith(PRIVATE_PREFIX)) return undefined;
  const suite = cases.slice(PRIVATE_PREFIX.length);
  if (!/^[a-z0-9][a-z0-9._-]*$/i.test(suite)) return { skip: `\`${cases}\` is not a suite name. Use --cases private:<suite>, for example private:turnkey-history.` };
  const root = env[PRIVATE_CASES_ENV]?.trim();
  if (!root) return { skip: `private suite ${suite} is not on this machine. Set ${PRIVATE_CASES_ENV} to the directory that holds it, then run again.` };
  const dir = join(root, suite);
  if (!existsSync(dir)) return { skip: `private suite ${suite} is not in ${root}. Check ${PRIVATE_CASES_ENV}.` };
  return { dir };
}
