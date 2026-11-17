/**
 * The reviewer and verifier prompts say the repository is checked out at
 * the PR head, and their recall depends on it: a defect in a helper the diff
 * never names is found only by reading the repository. A child whose clone
 * failed would review the diff alone and still post a confident review, so
 * its start fails instead and the delivery shows the error.
 *
 * The checkout is not where the child's commands start: the host clones into
 * a directory under the sandbox's working directory. The prompt names that
 * path, so the child's first `read` or `grep` finds the code.
 */
import type { RepoRunner } from "./context/repo.js";

/** The command a child's prepare step runs to read its checkout's path and commit. */
export const CHECKOUT_COMMAND = "git rev-parse --show-toplevel HEAD";

/** Throws unless the child's sandbox has a git checkout at `head`. Returns the checkout's absolute path. */
export async function assertCheckout(runner: RepoRunner, head: string): Promise<string> {
  const result = await runner.run(CHECKOUT_COMMAND, { timeoutMs: 30_000 });
  if (result.exitCode !== 0) {
    const reason = result.stderr.trim().split("\n")[0]?.slice(0, 200) || `exit code ${result.exitCode}`;
    throw new Error(`The review sandbox has no git checkout of the repository (${reason}). Check that the GitHub App can clone this repository, then retry the delivery.`);
  }
  const [root = "", at = ""] = result.stdout.trim().split("\n").map((line) => line.trim());
  if (at !== head) {
    throw new Error(`The review sandbox is at ${at.slice(0, 7) || "an unknown commit"}, not ${head.slice(0, 7)}. Retry the delivery.`);
  }
  if (!root.startsWith("/")) throw new Error(`The review sandbox reported no checkout path (${root.slice(0, 200) || "empty output"}). Retry the delivery.`);
  return root;
}

/** The prompt section that names the checkout path. */
export function checkoutSection(root: string): string {
  const quoted = `'${root.replace(/'/g, "'\\''")}'`;
  return [
    "# Checkout",
    `The repository is checked out at \`${root}\`. Your commands do not start there.`,
    `Start each \`bash\` command with \`cd ${quoted} && \`, and give \`read\` absolute paths under \`${root}\`.`,
  ].join("\n");
}

/** A prepare step that checks the checkout, runs `then` (or keeps the prompt), and puts the checkout path first. */
export function checkedOut(head: string, then?: (runner: RepoRunner, prompt: string) => Promise<string>): (runner: RepoRunner, prompt: string) => Promise<string> {
  return async (runner, prompt) => {
    const root = await assertCheckout(runner, head);
    const built = then ? await then(runner, prompt) : prompt;
    return `${checkoutSection(root)}\n\n${built}`;
  };
}
