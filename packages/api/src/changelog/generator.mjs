import { execFileSync } from "node:child_process";

export const CHANGELOG_SCHEMA = "valet-changelog/v1";

const INTERNAL_PREFIXES = new Set(["build", "chore", "ci", "docs", "refactor", "test"]);
const INTERNAL_PATH = /^(?:\.github\/|docs\/|scripts\/)|(?:^|\/)(?:__tests__|test|tests)\/|\.(?:test|spec)\.[cm]?[jt]sx?$/;
const DEPENDENCY_TITLE = /\b(?:dependabot|renovate|dependencies|dependency update|bump\s+\S+\s+from\s+)\b/i;
const USER_VISIBLE_MARKER = /\[(?:user-visible|changelog)\]/i;

function git(repo, args) {
  return execFileSync("git", ["-C", repo, ...args], { encoding: "utf8" }).trim();
}

function commit(repo, sha) {
  const record = git(repo, ["show", "-s", "--format=%H%x1f%aI%x1f%s%x1f%b", sha]);
  const [commitSha, authoredAt, subject, body = ""] = record.split("\x1f");
  const filesRaw = git(repo, ["diff-tree", "--no-commit-id", "--name-only", "-r", sha]);
  return { commitSha, authoredAt, subject, body, files: filesRaw ? filesRaw.split("\n") : [] };
}

function commitsInRange(repo, previousSha, releaseSha) {
  const range = previousSha ? `${previousSha}..${releaseSha}` : releaseSha;
  const shas = git(repo, ["rev-list", "--reverse", "--first-parent", range]);
  return shas ? shas.split("\n").map((sha) => commit(repo, sha)) : [];
}

export function classifyCommit(subject) {
  const match = /^([a-z]+)(?:\([^)]+\))?!?:\s*/i.exec(subject);
  const prefix = match?.[1]?.toLowerCase();
  if (prefix === "feat") return "feature";
  if (prefix === "fix") return "fix";
  if (prefix === "security") return "security";
  return "improvement";
}

function cleanTitle(subject) {
  const withoutMarker = subject.replace(USER_VISIBLE_MARKER, "").trim();
  const withoutPr = withoutMarker.replace(/\s*\(#\d+\)\s*$/, "");
  const withoutPrefix = withoutPr.replace(/^[a-z]+(?:\([^)]+\))?!?:\s*/i, "");
  const withoutIssue = withoutPrefix.replace(/^(?:TKAI-\d+\s*[:\-]?\s*)/i, "");
  if (!withoutIssue) return "Product update";
  return withoutIssue.charAt(0).toUpperCase() + withoutIssue.slice(1);
}

function descriptionFromBody(body, category) {
  const marked = /^(?:user impact|changelog):\s*(.+)$/im.exec(body)?.[1]?.replace(/\s+/g, " ").trim();
  if (marked) return marked.length > 240 ? `${marked.slice(0, 237).trimEnd()}...` : marked;
  return category === "fix"
    ? "This release corrects this behavior for users."
    : category === "security"
      ? "This release improves product security."
      : "This change is now available in Valet.";
}

export function shouldIncludeCommit(change) {
  const explicit = USER_VISIBLE_MARKER.test(`${change.subject}\n${change.body}`);
  if (explicit) return true;
  if (/^Merge\b/i.test(change.subject) || DEPENDENCY_TITLE.test(change.subject)) return false;
  const prefix = /^([a-z]+)(?:\([^)]+\))?!?:/i.exec(change.subject)?.[1]?.toLowerCase();
  if (prefix && INTERNAL_PREFIXES.has(prefix)) return false;
  return change.files.length === 0 || change.files.some((path) => !INTERNAL_PATH.test(path));
}

export function entryFromCommit(change) {
  const pr = /\(#(\d+)\)\s*$/.exec(change.subject)?.[1];
  const category = classifyCommit(change.subject);
  const title = cleanTitle(change.subject);
  return {
    title,
    description: descriptionFromBody(change.body, category),
    category,
    sources: {
      commitSha: change.commitSha,
      ...(pr ? { pullRequest: Number(pr) } : {}),
    },
    ...(pr ? { links: [{ label: `PR #${pr}`, url: `https://github.com/tkhq/valet/pull/${pr}` }] } : {}),
    followUp: !pr,
  };
}

export function generateCheckpoint({ repo, version, releaseSha, previousSha = null, releasedAt, releaseUrl }) {
  const resolvedSha = git(repo, ["rev-parse", `${releaseSha}^{commit}`]);
  const resolvedPrevious = previousSha ? git(repo, ["rev-parse", `${previousSha}^{commit}`]) : null;
  const date = releasedAt ?? git(repo, ["show", "-s", "--format=%aI", resolvedSha]);
  const entries = commitsInRange(repo, resolvedPrevious, resolvedSha)
    .filter(shouldIncludeCommit)
    .map(entryFromCommit);
  if (entries.length === 0) {
    throw new Error(`Changelog range ${resolvedPrevious ?? "(start)"}..${resolvedSha} has no user-facing entries.`);
  }
  return {
    id: `${version}@${resolvedSha}`,
    version,
    releasedAt: date,
    releasedSha: resolvedSha,
    previousSha: resolvedPrevious,
    ...(releaseUrl ? { releaseUrl } : {}),
    entries,
  };
}

export function upsertCheckpoint(manifest, checkpoint) {
  if (manifest.schema !== CHANGELOG_SCHEMA || !Array.isArray(manifest.checkpoints)) {
    throw new Error(`Manifest must use schema ${CHANGELOG_SCHEMA}.`);
  }
  const existing = manifest.checkpoints.find((item) => item.id === checkpoint.id);
  if (existing && JSON.stringify(existing) !== JSON.stringify(checkpoint)) {
    throw new Error(`Checkpoint ${checkpoint.id} is immutable and does not match the generated data.`);
  }
  const checkpoints = existing ? manifest.checkpoints : [...manifest.checkpoints, checkpoint];
  checkpoints.sort((a, b) => b.releasedAt.localeCompare(a.releasedAt) || b.id.localeCompare(a.id));
  return { schema: CHANGELOG_SCHEMA, generatedAt: checkpoint.releasedAt, checkpoints };
}

export function backfillTags({ repo, manifest, pattern }) {
  const refs = git(repo, ["tag", "--list", pattern, "--sort=creatordate"]);
  const tags = refs ? refs.split("\n") : [];
  let next = manifest;
  let previousSha = tags[0] ? git(repo, ["rev-parse", `${tags[0]}^`]) : null;
  for (const tag of tags) {
    const releaseSha = git(repo, ["rev-list", "-n", "1", tag]);
    const version = tag.replace(/^chart\/valet-v/, "").replace(/^v/, "");
    const checkpoint = generateCheckpoint({
      repo,
      version,
      releaseSha,
      previousSha,
      releaseUrl: `https://github.com/tkhq/valet/releases/tag/${encodeURIComponent(tag)}`,
    });
    next = upsertCheckpoint(next, checkpoint);
    previousSha = releaseSha;
  }
  return next;
}
