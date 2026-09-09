import { execFileSync } from "node:child_process";

export const USER_FACING_TYPES = Object.freeze(["feat", "fix", "improvement", "perf", "security"]);
export const INTERNAL_TYPES = Object.freeze(["build", "chore", "ci", "docs", "refactor", "test", "deps"]);

const ACCEPTED_TYPES = new Set([...USER_FACING_TYPES, ...INTERNAL_TYPES]);
const USER_FACING_TYPE_SET = new Set(USER_FACING_TYPES);
const USER_VISIBLE_MARKER = /\[user-visible\]/i;
const SUBJECT = /^([a-z]+)(?:\(([^()\r\n]+)\))?(!)?:\s+(\S.*)$/;
const TYPE_PREFIX = /^([^\s:()]+)(?:\([^)]*\))?!?:/;

function correctionForSubject(subject) {
  const prefix = TYPE_PREFIX.exec(subject)?.[1];
  if (prefix && !ACCEPTED_TYPES.has(prefix)) {
    return `Change the subject type "${prefix}" to one of: ${[...USER_FACING_TYPES, ...INTERNAL_TYPES].join(", ")}.`;
  }
  return 'Change the subject to "<type>: <summary>" with a lowercase accepted type and a non-empty summary.';
}

function changelogTrailer(body) {
  const trailerBlock = body.trimEnd().split(/\n\s*\n/).at(-1) ?? "";
  const lines = trailerBlock.split("\n");
  if (lines.some((line) => !/^[A-Za-z][A-Za-z-]*:\s+\S/.test(line))) return null;
  const match = lines.find((line) => line.startsWith("Changelog:"));
  return match?.slice("Changelog:".length).trim() || null;
}

export function parseCommitMessage({ subject, body = "" }) {
  const match = SUBJECT.exec(subject);
  const type = match?.[1];
  if (!match || !type || !ACCEPTED_TYPES.has(type)) {
    return { ok: false, correction: correctionForSubject(subject) };
  }
  const explicit = USER_VISIBLE_MARKER.test(subject);
  const changelog = changelogTrailer(body);
  const userFacing = USER_FACING_TYPE_SET.has(type) || explicit;
  return {
    ok: true,
    type,
    scope: match[2] || null,
    breaking: Boolean(match[3]),
    summary: match[4].trim(),
    explicit,
    changelog,
    userFacing,
    metadataValid: !userFacing || explicit || changelog !== null,
  };
}

export function validateCommitMessage({ commitSha, subject, body = "" }) {
  const parsed = parseCommitMessage({ subject, body });
  if (!parsed.ok) return [`${commitSha}: ${parsed.correction}`];
  if (!parsed.metadataValid) {
    return [
      `${commitSha}: Add "Changelog: <user impact>" to the commit body or add "[user-visible]" to the subject.`,
    ];
  }
  return [];
}

function git(repo, args) {
  return execFileSync("git", ["-C", repo, ...args], { encoding: "utf8" }).trim();
}

export function commitsIntroducedByPullRequest({ repo, baseSha, headSha }) {
  const resolvedBase = git(repo, ["rev-parse", `${baseSha}^{commit}`]);
  const resolvedHead = git(repo, ["rev-parse", `${headSha}^{commit}`]);
  const output = git(repo, ["rev-list", "--reverse", `${resolvedBase}..${resolvedHead}`]);
  if (!output) return [];
  return output.split("\n").map((sha) => {
    const record = git(repo, ["show", "-s", "--format=%H%x1f%s%x1f%b", sha]);
    const [commitSha, subject, body = ""] = record.split("\x1f");
    return { commitSha, subject, body };
  });
}
