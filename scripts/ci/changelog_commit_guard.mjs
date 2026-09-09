#!/usr/bin/env node

import {
  commitsIntroducedByPullRequest,
  validateCommitMessage,
} from "../../packages/api/src/changelog/commit-format.mjs";

function option(name) {
  const index = process.argv.indexOf(name);
  return index === -1 ? undefined : process.argv[index + 1];
}

const baseSha = option("--base");
const headSha = option("--head");
if (!baseSha || !headSha) {
  throw new Error("Set --base and --head to the pull request base and head SHAs.");
}

const commits = commitsIntroducedByPullRequest({ repo: process.cwd(), baseSha, headSha });
const failures = commits.flatMap(validateCommitMessage);
if (failures.length) {
  console.error("Changelog commit validation failed:");
  for (const failure of failures) console.error(`- ${failure}`);
  process.exitCode = 1;
} else {
  console.log(`Validated ${commits.length} commit(s) in ${baseSha}..${headSha}.`);
}
