/**
 * GitHub event normalization: subjects, status, and bot detection (spec:
 * docs/specs/2026-10-15-event-wakeups-design.md, Part A1/A2/A5).
 */
import type { EventSubjects, NormalizedEvent } from "@valet/engine";

function str(v: unknown): string | undefined {
  return typeof v === "string" ? v : undefined;
}

function num(v: unknown): number | undefined {
  return typeof v === "number" ? v : undefined;
}

function rec(v: unknown): Record<string, unknown> | undefined {
  return typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined;
}

function arr(v: unknown): unknown[] | undefined {
  return Array.isArray(v) ? v : undefined;
}

export interface GithubEventSubjectsResult {
  subjects: string[];
  status?: string;
  bot: boolean;
}

/** `github:<owner>/<repo>` lower-cased, from `repository.full_name`. */
function ownerRepoOf(payload: Record<string, unknown>): { owner: string; ownerRepo: string } | undefined {
  const fullName = str(rec(payload.repository)?.full_name);
  if (!fullName) return undefined;
  const lower = fullName.toLowerCase();
  const slash = lower.indexOf("/");
  const owner = slash === -1 ? lower : lower.slice(0, slash);
  return { owner, ownerRepo: lower };
}

/** Pull request / issue numbers this payload names (spec A2). */
function numbersOf(payload: Record<string, unknown>): Set<number> {
  const numbers = new Set<number>();
  const pr = num(rec(payload.pull_request)?.number);
  if (pr !== undefined) numbers.add(pr);
  const issue = num(rec(payload.issue)?.number);
  if (issue !== undefined) numbers.add(issue);
  for (const key of ["check_run", "check_suite", "workflow_run"] as const) {
    const prs = arr(rec(payload[key])?.pull_requests);
    if (!prs) continue;
    for (const item of prs) {
      const n = num(rec(item)?.number);
      if (n !== undefined) numbers.add(n);
    }
  }
  return numbers;
}

/** Commit SHAs this payload names (spec A2). */
function shasOf(payload: Record<string, unknown>): Set<string> {
  const shas = new Set<string>();
  for (const key of ["check_run", "check_suite", "workflow_run"] as const) {
    const sha = str(rec(payload[key])?.head_sha);
    if (sha) shas.add(sha);
  }
  const headSha = str(rec(rec(payload.pull_request)?.head)?.sha);
  if (headSha) shas.add(headSha);
  const statusSha = str(payload.sha);
  if (statusSha) shas.add(statusSha);
  return shas;
}

/** Status for one event (spec A2). */
function statusOf(eventType: string, payload: Record<string, unknown>): string | undefined {
  if (eventType === "check_run" || eventType === "check_suite" || eventType === "workflow_run") {
    return str(rec(payload[eventType])?.conclusion);
  }
  if (eventType === "pull_request_review") {
    return str(rec(payload.review)?.state)?.toLowerCase();
  }
  if (eventType === "pull_request") {
    if (str(payload.action) !== "closed") return undefined;
    return rec(payload.pull_request)?.merged === true ? "merged" : "closed";
  }
  if (eventType === "status") {
    return str(payload.state);
  }
  return undefined;
}

export function githubEventSubjects(eventType: string, payload: Record<string, unknown>): GithubEventSubjectsResult {
  const owners = ownerRepoOf(payload);
  const subjects: string[] = [];
  if (owners) {
    subjects.push(`github:${owners.owner}`);
    subjects.push(`github:${owners.ownerRepo}`);
    for (const n of numbersOf(payload)) subjects.push(`github:${owners.ownerRepo}#${n}`);
    for (const sha of shasOf(payload)) subjects.push(`github:${owners.ownerRepo}@${sha}`);
    const prHead = rec(rec(payload.pull_request)?.head);
    const suite = rec(rec(payload.check_run)?.check_suite) ?? rec(payload.check_suite);
    const workflow = rec(payload.workflow_run);
    let branch: string | undefined;
    if (prHead) {
      if (str(rec(prHead.repo)?.full_name)?.toLowerCase() === owners.ownerRepo) branch = str(prHead.ref);
    } else if (workflow) {
      if (str(rec(workflow.head_repository)?.full_name)?.toLowerCase() === owners.ownerRepo) branch = str(workflow.head_branch);
    } else if (suite) {
      const headRepo = str(rec(suite.head_repository)?.full_name);
      if (!headRepo || headRepo.toLowerCase() === owners.ownerRepo) branch = str(suite.head_branch);
    } else if (eventType === "push" && str(payload.ref)?.startsWith("refs/heads/")) {
      branch = str(payload.ref)?.slice("refs/heads/".length);
    }
    if (branch) subjects.push(`github:${owners.ownerRepo}:branch/${branch}`);
  }

  const bot = str(rec(payload.sender)?.type) === "Bot";
  const status = statusOf(eventType, payload);

  return { subjects, status, bot };
}

const SUBJECT_RE = /^github:[^/#@]+(?:\/[^/#@]+(?:#\d+|@[0-9a-f]+)?)?$/i;
const URL_RE = /^https:\/\/github\.com\/([^/]+)\/([^/]+?)(?:\/(pull|issues|commit)\/([^/?#]+))?\/?$/i;

function fromUrl(url: string): { subject: string; slackChannel?: string } | null {
  const branch = /^(?:https:\/\/github\.com\/|github:)([^/]+)\/([^/:]+)(?:\/tree\/|:branch\/)([^?#\s]+)$/.exec(url);
  if (branch) {
    let ref: string;
    try { ref = decodeURIComponent(branch[3]!); } catch { return null; }
    return { subject: `github:${branch[1]!.toLowerCase()}/${branch[2]!.toLowerCase()}:branch/${ref}` };
  }
  if (url.startsWith("github:")) {
    return SUBJECT_RE.test(url) ? { subject: url } : null;
  }
  const m = URL_RE.exec(url);
  if (!m) return null;
  const owner = m[1].toLowerCase();
  const repo = m[2].toLowerCase();
  const kind = m[3];
  const ref = m[4];
  if (!kind) return { subject: `github:${owner}/${repo}` };
  if (kind === "pull" || kind === "issues") return { subject: `github:${owner}/${repo}#${ref}` };
  return { subject: `github:${owner}/${repo}@${ref}` };
}

function label(subject: string): string {
  return subject.startsWith("github:") ? subject.slice("github:".length) : subject;
}

/** A `#n` subject resolves to the `/pull/n` form — GitHub redirects an issue
 * number to the matching pull request URL when one exists, and serves the
 * issue page otherwise. */
function url(subject: string): string | null {
  if (!subject.startsWith("github:")) return null;
  const rest = subject.slice("github:".length);
  const branch = /^([^/]+)\/([^/:]+):branch\/(.+)$/.exec(rest);
  if (branch) return `https://github.com/${branch[1]}/${branch[2]}/tree/${branch[3]!.split("/").map(encodeURIComponent).join("/")}`;
  const prMatch = /^([^/#@]+)\/([^/#@]+)#(\d+)$/.exec(rest);
  if (prMatch) return `https://github.com/${prMatch[1]}/${prMatch[2]}/pull/${prMatch[3]}`;
  const shaMatch = /^([^/#@]+)\/([^/#@]+)@([0-9a-f]+)$/i.exec(rest);
  if (shaMatch) return `https://github.com/${shaMatch[1]}/${shaMatch[2]}/commit/${shaMatch[3]}`;
  const repoMatch = /^([^/#@]+)\/([^/#@]+)$/.exec(rest);
  if (repoMatch) return `https://github.com/${repoMatch[1]}/${repoMatch[2]}`;
  const ownerMatch = /^[^/#@]+$/.exec(rest);
  if (ownerMatch) return `https://github.com/${rest}`;
  return null;
}

/** A `github:<owner>/<repo>#<n>` subject (a pull request or issue). */
const PR_OR_ISSUE_SUBJECT_RE = /^github:[^/#@]+\/[^/#@]+#\d+$/;
/** A `github:<owner>/<repo>` subject, with no pull request, issue, or sha. */
const REPO_SUBJECT_RE = /^github:[^/#@]+\/[^/#@]+$/;

/**
 * The pull request or issue an event names, else its repository (spec Part
 * D). Returns null when the event names no repository.
 */
export function githubNaturalSubject(event: NormalizedEvent): { subject: string; label: string } | null {
  const subject =
    event.subjects?.find((s) => PR_OR_ISSUE_SUBJECT_RE.test(s)) ?? event.subjects?.find((s) => REPO_SUBJECT_RE.test(s));
  if (!subject) return null;
  return { subject, label: subject.slice("github:".length) };
}

export const githubSubjects: EventSubjects = { fromUrl, label, url };
