/**
 * Import the Turnkey review trial as `pull_request` eval cases: one YAML
 * per PR in evals/cases/turnkey-trial.
 *
 *   pnpm --filter @valet/eval import:trial [--out <dir>]
 *
 * Source: PRs #1-#7 of the private repos tkhq/test-sdk, tkhq/test-go-sdk
 * and tkhq/test-rust-sdk. The trial author planted one defect in some PRs
 * and left others clean; ANSWER_KEYS records which, from the author's
 * stated intent (#1-#5) or from reading the diff (#6-#7, marked inferred).
 *
 * CodeRabbit reviewed these PRs during the trial. Its inline comments are
 * scored with the same extract, dedup and judge steps as Valet's review and
 * stored as the case's `coderabbit` reference. CodeRabbit had linked
 * companion repositories and saw the full PR description; Valet sees one
 * repository and the description without the trial notes (`reviewerBody`).
 *
 * Needs the `gh` CLI signed in with read access to the three repos, and
 * VALET_LLM_GATEWAY_URL plus a Valet key for the judge calls.
 */
import { execFile } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs, promisify } from "node:util";
import { stringify } from "yaml";
import { scoreReviewText } from "./checks/review-match.js";
import { llmGatewayFromEnv } from "./gateway.js";
import type { GoldenComment, ReviewCaseKind, ReviewMatchCheck } from "./types.js";

const run = promisify(execFile);
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");

interface AnswerKey {
  repo: "test-sdk" | "test-go-sdk" | "test-rust-sdk";
  number: number;
  kind: ReviewCaseKind;
  /** True when the key comes from reading the diff, not from the trial author's notes. */
  inferred?: boolean;
  golden: GoldenComment[];
}

const SHORT: Record<AnswerKey["repo"], string> = { "test-sdk": "ts", "test-go-sdk": "go", "test-rust-sdk": "rust" };

export const ANSWER_KEYS: AnswerKey[] = [
  // TypeScript
  { repo: "test-sdk", number: 1, kind: "setup", golden: [] },
  { repo: "test-sdk", number: 2, kind: "control", golden: [] },
  {
    repo: "test-sdk",
    number: 3,
    kind: "planted",
    golden: [
      {
        comment:
          "The freshness check drops Math.abs and only rejects timestamps older than maxTimestampAgeMs, so a signed webhook dated far in the future is accepted as fresh.",
        category: "security",
        severity: "High",
      },
    ],
  },
  {
    repo: "test-sdk",
    number: 4,
    kind: "planted",
    golden: [
      {
        comment:
          "useGeneric now returns true for every record, so records routed to the dedicated telemetry sink are also delivered to the generic sink (duplicate delivery), not only when fanout is set.",
        category: "bug",
        severity: "High",
      },
    ],
  },
  {
    repo: "test-sdk",
    number: 5,
    kind: "planted",
    golden: [
      {
        comment:
          "Renaming the event type from activity.completed to activity.succeeded breaks the Go and Rust consumers, which still expect activity.completed.",
        category: "api",
        severity: "High",
        cross_repo: true,
      },
    ],
  },
  {
    repo: "test-sdk",
    number: 6,
    kind: "planted",
    inferred: true,
    golden: [
      {
        comment:
          "Each hop of setCappedTimeout now waits min(MAX_DELAY_MS, delayMs) instead of the remaining time, so a timeout longer than MAX_DELAY_MS fires up to MAX_DELAY_MS late.",
        category: "bug",
        severity: "Medium",
      },
    ],
  },
  { repo: "test-sdk", number: 7, kind: "control", inferred: true, golden: [] },
  // Go
  { repo: "test-go-sdk", number: 1, kind: "setup", golden: [] },
  { repo: "test-go-sdk", number: 2, kind: "control", golden: [] },
  {
    repo: "test-go-sdk",
    number: 3,
    kind: "planted",
    golden: [
      {
        comment:
          "postAttempt builds the request with context.WithoutCancel(ctx), so HTTP requests are detached from the caller's cancellation and deadline; a cancelled caller no longer aborts the request.",
        category: "bug",
        severity: "High",
      },
    ],
  },
  {
    repo: "test-go-sdk",
    number: 4,
    kind: "planted",
    golden: [
      {
        comment:
          "Replicas changes from *int to int with omitempty, so an explicit zero disappears during serialization and the TypeScript and Rust consumers read it as absent instead of 0.",
        category: "api",
        severity: "High",
        cross_repo: true,
      },
    ],
  },
  {
    repo: "test-go-sdk",
    number: 5,
    kind: "planted",
    golden: [
      {
        comment:
          "The IAM trust-policy fixture removes the aud condition (sts.amazonaws.com), so a token from the issuer for any audience can assume the role.",
        category: "security",
        severity: "High",
      },
    ],
  },
  {
    repo: "test-go-sdk",
    number: 6,
    kind: "planted",
    inferred: true,
    golden: [
      {
        comment:
          "postAttempt marks every 4xx response as retryable (StatusCode >= 400), so client errors such as 400, 401 and 409 are retried and non-idempotent POSTs repeat, against the documented retry-on-5xx contract.",
        category: "bug",
        severity: "Medium",
      },
    ],
  },
  { repo: "test-go-sdk", number: 7, kind: "control", inferred: true, golden: [] },
  // Rust
  { repo: "test-rust-sdk", number: 1, kind: "setup", golden: [] },
  { repo: "test-rust-sdk", number: 2, kind: "control", golden: [] },
  {
    repo: "test-rust-sdk",
    number: 3,
    kind: "planted",
    golden: [
      {
        comment:
          "encryption_public_key_for_api_base_url maps any unknown API base URL to the production encryption key instead of failing, so custom or mistyped endpoints silently encrypt pull secrets to the production key.",
        category: "security",
        severity: "High",
      },
    ],
  },
  {
    repo: "test-rust-sdk",
    number: 4,
    kind: "planted",
    golden: [
      {
        comment:
          "The new gateway sidecar inherits the pod's service-account token: the change drops automountServiceAccountToken: false and the worker-only projected token, so the ingress-facing gateway gets a token with access to secrets.",
        category: "security",
        severity: "High",
      },
    ],
  },
  {
    repo: "test-rust-sdk",
    number: 5,
    kind: "planted",
    golden: [
      {
        comment: "The new error context formats input={pull_secret}, so raw pull-secret content leaks into error messages when key resolution fails.",
        category: "security",
        severity: "High",
      },
    ],
  },
  {
    repo: "test-rust-sdk",
    number: 6,
    kind: "planted",
    inferred: true,
    golden: [
      {
        comment:
          "The redirect policy compares only host_str, so a redirect to the same host with another scheme or port (for example an https to http downgrade) is followed with the request body preserved.",
        category: "security",
        severity: "High",
      },
    ],
  },
  { repo: "test-rust-sdk", number: 7, kind: "control", inferred: true, golden: [] },
];

const CODERABBIT_BLOCK = /<!-- This is an auto-generated comment: release notes by coderabbit\.ai -->[\s\S]*?<!-- end of auto-generated comment: release notes by coderabbit\.ai -->/g;

/**
 * The PR description Valet reviews: the author's first paragraph and the
 * companion-context list. It drops CodeRabbit's generated summary (written
 * after its own review) and the trial notes that name review tiers.
 */
export function reviewerBody(body: string): string {
  const text = body.replace(CODERABBIT_BLOCK, "").replace(/\r\n/g, "\n");
  const intro = text.trim().split(/\n\s*\n/)[0]?.trim() ?? "";
  const companion = /### Companion context\n([\s\S]*?)(?=\n### |$)/.exec(text)?.[1]?.trim();
  return companion ? `${intro}\n\n### Companion context\n\n${companion}` : intro;
}

/** One CodeRabbit inline comment as a reader sees it: no HTML, no agent prompt, no severity badge line. */
export function codeRabbitCommentText(body: string): string {
  return body
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/<details>[\s\S]*?<\/details>/g, "")
    .replace(/<[^>]+>/g, "")
    .replace(/^\*\*\s*(?:Critical|Major|Minor|Trivial)\*\*\s*·.*$/m, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

async function gh(args: string[]): Promise<string> {
  const { stdout } = await run("gh", args, { maxBuffer: 64 * 1024 * 1024 });
  return stdout;
}

interface PullView {
  title: string;
  body: string;
  baseRefOid: string;
  headRefOid: string;
}

async function main(): Promise<void> {
  const { values } = parseArgs({ options: { out: { type: "string" } } });
  const outDir = resolve(REPO_ROOT, values.out ?? "evals/cases/turnkey-trial");
  const gateway = llmGatewayFromEnv();
  if (gateway === undefined) throw new Error("Set VALET_LLM_GATEWAY_URL and VALET_API_KEY_FILE. The CodeRabbit reference needs the review judge.");
  await mkdir(outDir, { recursive: true });

  for (const key of ANSWER_KEYS) {
    const slug = `tkhq/${key.repo}`;
    const pr = JSON.parse(await gh(["pr", "view", String(key.number), "-R", slug, "--json", "title,body,baseRefOid,headRefOid"])) as PullView;
    const comments = JSON.parse(await gh(["api", "--paginate", "--slurp", `repos/${slug}/pulls/${key.number}/comments`])) as { user: { login: string }; body: string }[][];
    const coderabbit = comments
      .flat()
      .filter((c) => c.user.login.startsWith("coderabbitai"))
      .map((c) => codeRabbitCommentText(c.body))
      .filter((t) => t.length > 0);
    const check: ReviewMatchCheck = { type: "review_match", kind: key.kind, golden: key.golden };
    const scored = await scoreReviewText(check, coderabbit.join("\n\n---\n\n"), { gateway });
    const id = `trial-${SHORT[key.repo]}-${key.number}`;
    const doc = {
      id,
      description: `${pr.title} (${slug}#${key.number}, ${key.kind}${key.inferred ? ", answer key inferred from the diff" : ""})`,
      timeout_ms: 1_200_000,
      pull_request: {
        repo: `tkhq-${key.repo}`,
        remote: `https://github.com/${slug}.git`,
        base: pr.baseRefOid,
        head: pr.headRefOid,
        title: pr.title,
        body: reviewerBody(pr.body),
      },
      checks: [{ ...check, reference: { coderabbit: { matched: scored.matched, fp: scored.fp } } }],
    };
    const header = [
      "# Generated by packages/eval/src/trial-import.ts. Do not edit by hand.",
      "# Turnkey review trial. The repo is private: run with gh read access to tkhq.",
      ...(key.inferred ? ["# Answer key inferred from the diff, not from the trial author's notes."] : []),
    ].join("\n");
    await writeFile(join(outDir, `${id}.yaml`), `${header}\n${stringify(doc, { lineWidth: 0 })}`);
    console.error(`[trial] ${id}: ${key.kind}, coderabbit ${coderabbit.length} comment(s), matched ${scored.matched.length}/${key.golden.length}, fp ${scored.fp}`);
  }
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((err: unknown) => {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  });
}
