/**
 * Linear event normalization: subjects, status, and bot detection (spec:
 * docs/specs/2026-10-15-event-wakeups-design.md, Part A1/A4/A5).
 *
 * Errata on A4: the webhook's actor field is confirmed at the payload's
 * TOP LEVEL as `actor.type` (not nested under `data`), matching Linear's
 * public webhook documentation — `"user"` for a human actor, `"application"`
 * for an OAuth app / bot actor. No change to A4's wording was needed.
 */
import type { EventSubjects } from "@valet/engine";

function str(v: unknown): string | undefined {
  return typeof v === "string" ? v : undefined;
}

function rec(v: unknown): Record<string, unknown> | undefined {
  return typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined;
}

export interface LinearEventSubjectsResult {
  subjects: string[];
  status?: string;
  bot: boolean;
}

export function linearEventSubjects(type: string, payload: Record<string, unknown>): LinearEventSubjectsResult {
  const data = rec(payload.data) ?? {};
  const subjects: string[] = [];
  let status: string | undefined;

  if (type === "Issue") {
    const teamKey = str(rec(data.team)?.key);
    if (teamKey) subjects.push(`linear:team/${teamKey}`);
    const identifier = str(data.identifier);
    if (identifier) subjects.push(`linear:${identifier}`);
    status = str(rec(data.state)?.type);
  } else if (type === "Comment") {
    const issue = rec(data.issue);
    const teamKey = str(rec(issue?.team)?.key) ?? str(rec(data.team)?.key);
    if (teamKey) subjects.push(`linear:team/${teamKey}`);
    const identifier = str(issue?.identifier);
    if (identifier) subjects.push(`linear:${identifier}`);
  } else {
    const teamKey = str(rec(data.team)?.key);
    if (teamKey) subjects.push(`linear:team/${teamKey}`);
  }

  const actorType = str(rec(payload.actor)?.type);
  const bot = actorType !== undefined && actorType !== "user";

  return { subjects, status, bot };
}

const SUBJECT_RE = /^linear:(team\/)?[A-Za-z0-9_-]+$/;

function fromUrl(url: string): { subject: string; slackChannel?: string } | null {
  if (url.startsWith("linear:")) {
    return SUBJECT_RE.test(url) ? { subject: url } : null;
  }
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (parsed.hostname !== "linear.app") return null;
  const parts = parsed.pathname.split("/").filter(Boolean);
  const issueIdx = parts.indexOf("issue");
  if (issueIdx !== -1 && parts[issueIdx + 1]) {
    return { subject: `linear:${parts[issueIdx + 1]}` };
  }
  const teamIdx = parts.indexOf("team");
  if (teamIdx !== -1 && parts[teamIdx + 1]) {
    return { subject: `linear:team/${parts[teamIdx + 1]}` };
  }
  return null;
}

function label(subject: string): string {
  return subject.startsWith("linear:") ? subject.slice("linear:".length) : subject;
}

/** A team subject has no stand-alone URL — Linear's team views live under a
 * workspace slug the subject does not carry, so only issue subjects resolve. */
function url(subject: string): string | null {
  if (!subject.startsWith("linear:")) return null;
  const rest = subject.slice("linear:".length);
  if (rest.startsWith("team/")) return null;
  return `https://linear.app/issue/${rest}`;
}

export const linearSubjects: EventSubjects = { fromUrl, label, url };
