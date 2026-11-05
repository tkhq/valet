/**
 * Code review lines: the event subscriptions that hand pull request events
 * to the PR review plugin's handler. Each line covers the repositories its
 * `repo` condition names. The Code review page reads and writes them as
 * ordinary lines (`~/api/events`), so Presence lists them too.
 */
import type { CreateEventSubscriptionRequest, EventSubscriptionFilterWire, EventSubscriptionWire } from "@valet/api/wire";
import type { HandlerOption } from "~/components/plugins/handler-settings";

export const REVIEW_PLUGIN = "pr-review";
export const REVIEW_HANDLER = "review-pull-request";

/** True for a line that runs the PR review handler. */
export function isReviewLine(sub: EventSubscriptionWire): boolean {
  return sub.target.kind === "plugin" && sub.target.plugin === REVIEW_PLUGIN && sub.target.handler === REVIEW_HANDLER;
}

/** Whether every repository condition allows this repository. Other event conditions do not change repository coverage. */
export function coversRepository(line: EventSubscriptionWire, repo: string): boolean {
  return isReviewLine(line) && line.filters
    .filter((filter) => filter.field === "repo")
    .every((filter) => repositoryFilterMatches(repo, filter));
}

/** Mirrors events/match.ts, with case-insensitive GitHub repository identity for equality lists. */
function repositoryFilterMatches(repo: string, filter: EventSubscriptionFilterWire): boolean {
  const value = filter.value;
  switch (filter.op) {
    case "eq":
      return typeof value === "string" && repo.toLowerCase() === value.toLowerCase();
    case "in":
    case "not_in": {
      if (!Array.isArray(value)) return false;
      const included = value.some((entry) => entry.toLowerCase() === repo.toLowerCase());
      return included === (filter.op === "in");
    }
    case "prefix":
      return typeof value === "string" && repo.startsWith(value);
    case "contains":
      return typeof value === "string" && repo.includes(value);
    case "not_prefix":
      return typeof value === "string" && !repo.startsWith(value);
    case "regex":
    case "not_regex":
      if (typeof value !== "string") return false;
      try {
        return new RegExp(value).test(repo.slice(0, 2_000)) === (filter.op === "regex");
      } catch {
        return false;
      }
  }
}

/** The repositories a line covers, or null when no `repo` condition limits it. */
export function lineRepos(sub: EventSubscriptionWire): string[] | null {
  const repos = sub.filters.flatMap((f) => {
    if (f.field !== "repo") return [];
    if (f.op === "eq" && typeof f.value === "string") return [f.value];
    if (f.op === "in" && Array.isArray(f.value)) return f.value.filter((v): v is string => typeof v === "string");
    return [];
  });
  return repos.length > 0 ? repos : null;
}

/** A single-repository condition makes a line safe to toggle from that repository's row. */
export function isSingleRepositoryLine(line: EventSubscriptionWire): boolean {
  const repos = lineRepos(line);
  return repos !== null && new Set(repos.map((repo) => repo.toLowerCase())).size === 1;
}

/** The body that turns code review on for one repository, with default settings. */
export function reviewLineBody(repo: string, handler: HandlerOption, teamId?: string): CreateEventSubscriptionRequest {
  return {
    name: `Code review: ${repo}`,
    eventKeys: handler.events,
    filters: [{ field: "repo", op: "eq", value: repo }],
    target: { kind: "plugin", plugin: handler.plugin, handler: handler.id, ...(teamId !== undefined ? { teamId } : {}) },
  };
}

/** The pull request on GitHub, at Valet's review when there is one. */
export function pullRequestUrl(repo: string, number: number, reviewId?: number): string {
  return `https://github.com/${repo}/pull/${number}${reviewId !== undefined ? `#pullrequestreview-${reviewId}` : ""}`;
}
