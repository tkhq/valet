/**
 * Review one change in a local checkout and print the review as markdown.
 *
 *   pnpm --filter @valet/plugin-pr-review review --repo /abs/checkout \
 *     --base origin/dev-v2 [--head HEAD] [--title "..."] [--model anthropic/claude-sonnet-5-5] \
 *     [--state reviews.json --key owner/repo#123]
 *
 * The checkout must already be at --head; the reviewer reads files from it.
 * With --state, the review builds on earlier runs for the same --key: after
 * the first run it reviews only the new commits and reports which earlier
 * findings are fixed.
 *
 * With VALET_LLM_GATEWAY_URL and VALET_API_KEY (or VALET_API_KEY_FILE) set,
 * model calls go through that Valet gateway with the Valet key.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { ReasoningLevel } from "@valet/engine";
import { git } from "../src/git.js";
import { reviewPullRequestIncrement } from "../src/incremental.js";
import { createLocalAgentRunner, reviewPullRequest, tally, type LlmGatewayConfig } from "../src/review.js";
import { fileReviewState } from "../src/state.js";
import type { Finding } from "../src/types.js";

function gatewayFromEnv(): LlmGatewayConfig | undefined {
  const url = process.env.VALET_LLM_GATEWAY_URL?.trim();
  if (!url) return undefined;
  const key = process.env.VALET_API_KEY?.trim() || (process.env.VALET_API_KEY_FILE ? readFileSync(process.env.VALET_API_KEY_FILE, "utf8").trim() : "");
  if (!key.startsWith("vlt_")) throw new Error("VALET_LLM_GATEWAY_URL is set but no vlt_ key was found. Set VALET_API_KEY or VALET_API_KEY_FILE.");
  return { url: url.replace(/\/+$/, ""), apiKey: key };
}

function printFinding(f: Finding & { id?: string }): void {
  console.log(`### ${f.id ? `[${f.id}] ` : ""}${f.severity.toUpperCase()} ${f.path}:${f.line} - ${f.title}\n\n${f.body}\n`);
  if (f.suggestion) console.log("```suggestion\n" + f.suggestion + "\n```\n");
}

function parseFlags(argv: string[]): Record<string, string> {
  const flags: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith("--") && argv[i + 1] !== undefined) flags[argv[i].slice(2)] = argv[++i];
  }
  return flags;
}

function flagString(flags: Record<string, string>, name: string): string | undefined {
  return flags[name];
}

async function main(): Promise<void> {
  const flags = parseFlags(process.argv.slice(2));
  const repo = resolve(flagString(flags, "repo") ?? process.cwd());
  const baseRef = flagString(flags, "base");
  if (!baseRef) throw new Error("Pass --base <ref>, the branch or commit the change merges into.");
  const base = (await git(repo, ["merge-base", baseRef, flagString(flags, "head") ?? "HEAD"])).trim();
  const head = (await git(repo, ["rev-parse", flagString(flags, "head") ?? "HEAD"])).trim();
  const title = flagString(flags, "title") ?? (await git(repo, ["log", "-1", "--format=%s", head])).trim();

  const model = flagString(flags, "model") ?? "anthropic/claude-sonnet-5-5";
  const reasoning = flagString(flags, "reasoning") as ReasoningLevel | undefined;
  const gateway = gatewayFromEnv();
  const onToolCall = (tool: string, args: unknown): void => {
    process.stderr.write(`  ${tool} ${JSON.stringify(args).slice(0, 140)}\n`);
  };

  const statePath = flagString(flags, "state");
  if (statePath !== undefined) {
    const key = flagString(flags, "key");
    if (!key) throw new Error("Pass --key <owner/repo#number> with --state, so each PR keeps its own history.");
    const startedAt = Date.now();
    const { run, entries } = createLocalAgentRunner({ workspace: repo, model, ...(reasoning ? { reasoning } : {}), ...(gateway ? { gateway } : {}), onToolCall });
    const r = await reviewPullRequestIncrement(
      { workspace: repo, base, head, title, body: flagString(flags, "body") ?? "", key, store: fileReviewState(resolve(statePath)) },
      run,
    );
    const { usage } = tally(entries);
    process.stderr.write(`\n${r.mode} review: ${((Date.now() - startedAt) / 1000).toFixed(0)}s, $${usage.costUsd.toFixed(2)}\n\n`);
    if (r.mode === "unchanged") {
      console.log(`Already reviewed ${head.slice(0, 12)}. ${r.stillOpen.length} finding(s) open.`);
      return;
    }
    if (r.pipeline?.review) console.log(`## Summary\n\n${r.pipeline.review.summary}\n\n**Confidence: ${r.pipeline.review.confidence}/5**\n`);
    console.log(`## New findings (${r.posted.length})\n`);
    r.posted.forEach(printFinding);
    if (r.resolved.length > 0) {
      console.log(`## Fixed since the last review (${r.resolved.length})\n`);
      for (const f of r.resolved) console.log(`- [${f.id}] ${f.path} ${f.title}: ${f.resolution ?? "fixed"}`);
      console.log("");
    }
    if (r.stillOpen.length > 0) {
      console.log(`## Still open (${r.stillOpen.length})\n`);
      for (const f of r.stillOpen) console.log(`- [${f.id}] ${f.path}:${f.line} ${f.title}`);
    }
    if (r.pipeline?.outcome !== "completed") process.exit(1);
    return;
  }

  const run = await reviewPullRequest({
    workspace: repo,
    base,
    head,
    title,
    body: flagString(flags, "body") ?? "",
    model,
    ...(reasoning ? { reasoning } : {}),
    ...(gateway ? { gateway } : {}),
    onToolCall,
  });

  process.stderr.write(`\n${run.outcome}: ${run.toolCalls} tool calls, ${(run.durationMs / 1000).toFixed(0)}s, $${run.usage.costUsd.toFixed(2)}\n\n`);
  if (!run.review) {
    console.log(run.error ?? "The reviewer did not submit a review.");
    process.exit(1);
  }
  const r = run.review;
  console.log(`## Summary\n\n${r.summary}\n\n**Confidence: ${r.confidence}/5**\n`);
  r.findings.forEach(printFinding);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
