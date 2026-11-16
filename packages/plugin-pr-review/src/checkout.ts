/**
 * The reviewer and verifier prompts say the repository is checked out at
 * the PR head, and their recall depends on it: a defect in a helper the diff
 * never names is found only by reading the repository. A child whose clone
 * failed would review the diff alone and still post a confident review, so
 * its start fails instead and the delivery shows the error.
 */
import type { RepoRunner } from "./context/repo.js";

/** The command a child's prepare step runs to read its checkout's commit. */
export const CHECKOUT_COMMAND = "git rev-parse HEAD";

/** Throws unless the child's sandbox has a git checkout at `head`. */
export async function assertCheckout(runner: RepoRunner, head: string): Promise<void> {
  const result = await runner.run(CHECKOUT_COMMAND, { timeoutMs: 30_000 });
  if (result.exitCode !== 0) {
    const reason = result.stderr.trim().split("\n")[0]?.slice(0, 200) || `exit code ${result.exitCode}`;
    throw new Error(`The review sandbox has no git checkout of the repository (${reason}). Check that the GitHub App can clone this repository, then retry the delivery.`);
  }
  const at = result.stdout.trim();
  if (at !== head) {
    throw new Error(`The review sandbox is at ${at.slice(0, 7) || "an unknown commit"}, not ${head.slice(0, 7)}. Retry the delivery.`);
  }
}

/** A prepare step that checks the checkout, then runs `then` (or keeps the prompt). */
export function checkedOut(head: string, then?: (runner: RepoRunner, prompt: string) => Promise<string>): (runner: RepoRunner, prompt: string) => Promise<string> {
  return async (runner, prompt) => {
    await assertCheckout(runner, head);
    return then ? then(runner, prompt) : prompt;
  };
}
