#!/usr/bin/env node

import { readFileSync } from "node:fs";
import {
  commitsIntroducedByPullRequest,
  validateCommitMessage,
} from "../../packages/api/src/changelog/commit-format.mjs";

function option(name) {
  const index = process.argv.indexOf(name);
  return index === -1 ? undefined : process.argv[index + 1];
}

function report(commits, success) {
  const failures = commits.flatMap(validateCommitMessage);
  if (failures.length) {
    console.error("Changelog commit validation failed:");
    for (const failure of failures) console.error(`- ${failure}`);
    process.exitCode = 1;
  } else if (success) {
    console.log(success);
  }
}

function main() {
  const messageFile = option("--message-file");
  if (messageFile) {
    const [subject = "", ...body] = readFileSync(messageFile, "utf8").split(/\r?\n/);
    const messageBody = body.join("\n").replace(/^[ \t]*\n/, "");
    report([{ commitSha: "commit message", subject, body: messageBody }]);
    return;
  }

  const baseSha = option("--base");
  const headSha = option("--head");
  if (!baseSha || !headSha) {
    throw new Error("Set --base and --head, or set --message-file.");
  }
  const commits = commitsIntroducedByPullRequest({ repo: process.cwd(), baseSha, headSha });
  report(commits, `Validated ${commits.length} commit(s) in ${baseSha}..${headSha}.`);
}

try {
  main();
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 2;
}
