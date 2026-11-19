import type { GitPushFacts } from "../types.js";

/** `git push` in command position: the start, or after `;`, `&&`, `||`, `|`, `(`, or `$(`. */
const GIT_PUSH = /(?:^|[;&|(\n]|\$\()\s*git(?:\s+-C\s+\S+)?\s+push\b/;
/** `To https://github.com/owner/name.git` or `To github.com:owner/name.git`. */
const PUSH_TARGET = /^To\s+\S*?[/:]([^/\s:]+)\/([^/\s]+?)(?:\.git)?\/?\s*$/m;
/** A ref line: `   1a2b3c4..5d6e7f8  main -> main`, ` + 1a2b...5d6e  b -> b (forced update)`, ` * [new branch]  b -> b`. */
const REF_LINE = /^\s*[ +*]?\s*(?:[0-9a-f]{7,40}\.{2,3}([0-9a-f]{7,40})|\[new branch\])\s+\S+\s+->\s+(\S+)/m;

/**
 * The repository, branch and new head of a successful `git push`, read from
 * the command and git's own report. Undefined when the command is not a push
 * or it failed. The head is absent for a new branch: git does not print it.
 */
export function gitPushFacts(command: string, output: string, exitCode: number | undefined): GitPushFacts | undefined {
  if (exitCode !== 0 || !GIT_PUSH.test(command)) return undefined;
  if (/^Everything up-to-date\s*$/m.test(output) && !REF_LINE.test(output)) return undefined;
  const target = output.match(PUSH_TARGET);
  const ref = output.match(REF_LINE);
  const branch = ref?.[2]?.replace(/^refs\/heads\//, "");
  return {
    ...(target ? { repo: `${target[1]}/${target[2]}` } : {}),
    ...(branch ? { branch } : {}),
    ...(ref?.[1] ? { headSha: ref[1] } : {}),
  };
}
