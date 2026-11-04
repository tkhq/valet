/**
 * Code review lines: the event subscriptions that hand pull request events
 * to the PR review plugin's handler. Each line covers the repositories its
 * `repo` condition names. The Code review page reads and writes them as
 * ordinary lines (`~/api/events`), so Presence lists them too.
 */
import type { CreateEventSubscriptionRequest, EventSubscriptionWire } from "@valet/api/wire";
import type { HandlerOption } from "~/components/plugins/handler-settings";

export const REVIEW_PLUGIN = "pr-review";
export const REVIEW_HANDLER = "review-pull-request";

/** True for a line that runs the PR review handler. */
export function isReviewLine(sub: EventSubscriptionWire): boolean {
  return sub.target.kind === "plugin" && sub.target.plugin === REVIEW_PLUGIN && sub.target.handler === REVIEW_HANDLER;
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
