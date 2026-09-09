import { execFileSync } from "node:child_process";
import { parseCommitMessage } from "./commit-format.mjs";

export const CHANGELOG_SCHEMA = "valet-changelog/v2";

const INTERNAL_PATH = /^(?:\.github\/|docs\/|scripts\/|packages\/eval\/)|(?:^|\/)(?:__tests__|test|tests)\/|\.(?:test|spec)\.[cm]?[jt]sx?$/;
const DEPENDENCY_TITLE = /\b(?:dependabot|renovate|dependencies|dependency update|bump\s+\S+\s+from\s+)\b/i;
const USER_VISIBLE_MARKER = /\[user-visible\]/i;

function git(repo, args) {
  return execFileSync("git", ["-C", repo, ...args], { encoding: "utf8" }).trim();
}

function normalizeTimestamp(value) {
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) throw new Error(`Invalid release timestamp: ${value}`);
  return new Date(timestamp).toISOString();
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
  const parsed = parseCommitMessage({ subject, body: "" });
  const prefix = parsed.ok ? parsed.type : undefined;
  if (prefix === "feat") return "feature";
  if (prefix === "fix") return "fix";
  if (prefix === "security") return "security";
  return "improvement";
}

function cleanTitle(subject) {
  const withoutMarker = subject.replace(USER_VISIBLE_MARKER, "").trim();
  const withoutPr = withoutMarker.replace(/\s*\(#\d+\)\s*$/, "");
  const withoutPrefix = withoutPr.replace(/^[a-z]+(?:\([^)]+\))?!?:\s*/i, "");
  const withoutIssue = withoutPrefix
    .replace(/^(?:TKAI-\d+\s*[:\-]?\s*)/i, "")
    .replace(/\s*\(TKAI-\d+\)\s*$/i, "");
  if (!withoutIssue) return "Product update";
  return withoutIssue.charAt(0).toUpperCase() + withoutIssue.slice(1);
}

function fallbackDescription(title, category) {
  const topic = title.replace(/[.!?]+$/, "");
  if (category === "fix") return `Fixed: ${topic}.`;
  if (category === "security") return `Security update: ${topic}.`;
  if (category === "feature") return `Available now: ${topic}.`;
  return `Improved: ${topic}.`;
}

function descriptionFromBody(body, title, category) {
  const parsed = parseCommitMessage({ subject: `feat: ${title}`, body });
  const marked = (
    (parsed.ok ? parsed.changelog : null) ?? /^user impact:\s*(.+)$/im.exec(body)?.[1]
  )
    ?.replace(/\s+/g, " ")
    .trim();
  if (marked) {
    return { description: marked.length > 240 ? `${marked.slice(0, 237).trimEnd()}...` : marked, followUp: false };
  }
  return { description: fallbackDescription(title, category), followUp: true };
}

export function shouldIncludeCommit(change) {
  const parsed = parseCommitMessage(change);
  if (!parsed.ok || !parsed.userFacing) return false;
  if (parsed.metadataValid) return true;
  if (DEPENDENCY_TITLE.test(change.subject)) return false;
  return change.files.length === 0 || change.files.some((path) => !INTERNAL_PATH.test(path));
}

export function entryFromCommit(change) {
  const pr = /\(#(\d+)\)\s*$/.exec(change.subject)?.[1];
  const category = classifyCommit(change.subject);
  const title = cleanTitle(change.subject);
  const { description, followUp } = descriptionFromBody(change.body, title, category);
  return {
    title,
    description,
    category,
    sources: {
      commitSha: change.commitSha,
      ...(pr ? { pullRequest: Number(pr) } : {}),
    },
    ...(pr ? { links: [{ label: `PR #${pr}`, url: `https://github.com/tkhq/valet/pull/${pr}` }] } : {}),
    followUp,
  };
}

function generatedEntries(repo, previousSha, targetSha) {
  const resolvedSha = git(repo, ["rev-parse", `${targetSha}^{commit}`]);
  const resolvedPrevious = previousSha ? git(repo, ["rev-parse", `${previousSha}^{commit}`]) : null;
  if (resolvedPrevious) {
    try {
      git(repo, ["merge-base", "--is-ancestor", resolvedPrevious, resolvedSha]);
    } catch {
      throw new Error(`Changelog target ${resolvedSha} does not descend from ${resolvedPrevious}.`);
    }
  }
  const entries = commitsInRange(repo, resolvedPrevious, resolvedSha)
    .filter(shouldIncludeCommit)
    .map(entryFromCommit);
  return { resolvedSha, resolvedPrevious, entries };
}

export function generateCheckpoint({ repo, version, releaseSha, previousSha = null, releasedAt, releaseUrl }) {
  if (!releasedAt) throw new Error("Set releasedAt from authoritative release metadata.");
  const { resolvedSha, resolvedPrevious, entries } = generatedEntries(repo, previousSha, releaseSha);
  return {
    kind: "released",
    id: `${version}@${resolvedSha}`,
    version,
    releasedAt: normalizeTimestamp(releasedAt),
    releasedSha: resolvedSha,
    previousSha: resolvedPrevious,
    ...(releaseUrl ? { releaseUrl } : {}),
    entries,
  };
}

export function generateUnreleasedCheckpoint({ repo, buildSha, previousSha = null, builtAt, buildUrl }) {
  if (!builtAt) throw new Error("Set builtAt from stable build metadata.");
  const { resolvedSha, resolvedPrevious, entries } = generatedEntries(repo, previousSha, buildSha);
  return {
    kind: "unreleased",
    id: `unreleased@${resolvedSha}`,
    buildSha: resolvedSha,
    builtAt: normalizeTimestamp(builtAt),
    previousSha: resolvedPrevious,
    ...(buildUrl ? { buildUrl } : {}),
    entries,
  };
}

function releasedCheckpoints(manifest) {
  return manifest.checkpoints.filter((checkpoint) => checkpoint.kind === "released");
}

function normalizeReleased(checkpoint) {
  return { ...checkpoint, releasedAt: normalizeTimestamp(checkpoint.releasedAt) };
}

export function upsertCheckpoint(manifest, checkpoint) {
  if (manifest.schema !== CHANGELOG_SCHEMA || !Array.isArray(manifest.checkpoints)) {
    throw new Error(`Manifest must use schema ${CHANGELOG_SCHEMA}.`);
  }
  const normalized = normalizeReleased(checkpoint);
  const released = releasedCheckpoints(manifest).map(normalizeReleased);
  const existing = released.find((item) => item.id === normalized.id);
  if (existing && JSON.stringify(existing) !== JSON.stringify(normalized)) {
    throw new Error(`Checkpoint ${normalized.id} is immutable and does not match the generated data.`);
  }
  const checkpoints = existing ? released : [...released, normalized];
  checkpoints.sort(
    (a, b) => Date.parse(b.releasedAt) - Date.parse(a.releasedAt) || b.id.localeCompare(a.id),
  );
  return {
    schema: CHANGELOG_SCHEMA,
    generatedAt: checkpoints[0]?.releasedAt ?? new Date(0).toISOString(),
    checkpoints,
  };
}

export function replaceUnreleasedCheckpoint(manifest, checkpoint) {
  if (manifest.schema !== CHANGELOG_SCHEMA || !Array.isArray(manifest.checkpoints)) {
    throw new Error(`Manifest must use schema ${CHANGELOG_SCHEMA}.`);
  }
  const normalized = { ...checkpoint, builtAt: normalizeTimestamp(checkpoint.builtAt) };
  const released = releasedCheckpoints(manifest).map(normalizeReleased);
  return {
    schema: CHANGELOG_SCHEMA,
    generatedAt: normalized.builtAt,
    checkpoints: [normalized, ...released],
  };
}

export function backfillTags({ repo, manifest, patterns }) {
  const refs = git(repo, [
    "tag",
    "--list",
    ...patterns,
    "--sort=creatordate",
    "--format=%(refname:short)%00%(creatordate:iso-strict)",
  ]);
  const released = releasedCheckpoints(manifest).map(normalizeReleased);
  const baseline = released[0];
  const baselineTime = baseline ? Date.parse(baseline.releasedAt) : Number.NEGATIVE_INFINITY;
  const tags = refs
    ? refs.split("\n").map((line) => {
        const [tag, releasedAt] = line.split("\0");
        return { tag, releasedAt };
      }).filter(({ releasedAt }) => Date.parse(releasedAt) > baselineTime)
    : [];
  let next = {
    schema: CHANGELOG_SCHEMA,
    generatedAt: baseline?.releasedAt ?? new Date(0).toISOString(),
    checkpoints: released,
  };
  let previousSha = baseline?.releasedSha ?? (tags[0] ? git(repo, ["rev-parse", `${tags[0].tag}^`]) : null);
  for (const { tag, releasedAt } of tags) {
    const releaseSha = git(repo, ["rev-list", "-n", "1", tag]);
    const version = tag.replace(/^chart\/valet-v/, "").replace(/^v/, "");
    const checkpoint = generateCheckpoint({
      repo,
      version,
      releaseSha,
      previousSha,
      releasedAt,
      releaseUrl: `https://github.com/tkhq/valet/releases/tag/${encodeURIComponent(tag)}`,
    });
    next = upsertCheckpoint(next, checkpoint);
    previousSha = releaseSha;
  }
  return next;
}
