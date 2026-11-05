import { execFileSync } from "node:child_process";

export const USER_FACING_TYPES = Object.freeze(["feat", "fix", "improvement", "perf", "security"]);
export const INTERNAL_TYPES = Object.freeze(["build", "chore", "ci", "docs", "refactor", "test", "deps"]);

const ACCEPTED_TYPES = new Set([...USER_FACING_TYPES, ...INTERNAL_TYPES]);
const USER_FACING_TYPE_SET = new Set(USER_FACING_TYPES);
const USER_VISIBLE_MARKER = /\[user-visible\]/i;
/**
 * Trailer values that mean "keep this out of the changelog". Authors reach
 * for these on a user-facing type whose change no user can see — a test
 * fixture, a pinned assertion. The value used to be read as the user impact
 * and published verbatim, so the changelog showed the word "none".
 */
const CHANGELOG_OPT_OUT = new Set(["none", "n/a", "na", "-", "skip", "internal"]);
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
  const trailer = changelogTrailer(body);
  const changelogOptOut = trailer !== null && CHANGELOG_OPT_OUT.has(trailer.toLowerCase());
  // An opt-out is a declaration, not an impact line. It satisfies the guard
  // and leaves no description for the generator to publish.
  const changelog = changelogOptOut ? null : trailer;
  const userFacing = USER_FACING_TYPE_SET.has(type) || explicit;
  return {
    ok: true,
    type,
    scope: match[2] || null,
    breaking: Boolean(match[3]),
    summary: match[4].trim(),
    explicit,
    changelog,
    changelogOptOut,
    userFacing,
    metadataValid: !userFacing || explicit || trailer !== null,
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
