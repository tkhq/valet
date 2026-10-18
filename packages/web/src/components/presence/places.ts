/**
 * Place helpers the Presence overview and pages share
 * (docs/specs/2026-10-16-presence-hub-design.md Part B). The places API
 * returns every grain. The overview keeps the service-wide rows and the mid
 * grain: Slack channels, GitHub repositories, and Linear teams.
 */
import type { EventSubscriptionFilterWire, PresencePlaceService, PresencePlaceWire } from "@valet/api/wire";

export const SERVICE_NAMES: Readonly<Record<PresencePlaceService, string>> = {
  slack: "Slack",
  github: "GitHub",
  linear: "Linear",
};

/** A service-wide row: the Slack workspace (`slack:<team>`), `github:*`, or `linear:*`. */
export function isServiceRoot(place: Pick<PresencePlaceWire, "subject" | "parent">): boolean {
  if (place.parent !== null) return false;
  return place.subject === "github:*" || place.subject === "linear:*" || /^slack:[^/]+$/.test(place.subject);
}

const SLACK_CHANNEL = /^slack:[^/]+\/([^/]+)$/;
const GITHUB_REPO = /^github:[^/#@]+\/[^/#@]+$/;
const LINEAR_TEAM = /^linear:team\/[^/]+$/;

/** A row at the mid grain: a Slack channel, a GitHub repository, or a Linear team.
 * A pull request, an issue, and a Linear issue are not. */
export function isMidGrain(place: Pick<PresencePlaceWire, "subject">): boolean {
  return SLACK_CHANNEL.test(place.subject) || GITHUB_REPO.test(place.subject) || LINEAR_TEAM.test(place.subject);
}

/** A Slack key's channel: `slack:<team>/<channel>`, or a thread under it. */
const SLACK_CHANNEL_PREFIX = /^slack:[^/]+\/([^/]+)/;

/**
 * The `q` that `View all` sends to Activity for a place (spec Part C step
 * 7). The server matches `q` against an event's summary and key, and a
 * Slack summary carries the channel id (`app mentioned in C900 by U1`), not
 * the channel name. So a Slack place searches by its channel id, and every
 * other place by its label (`acme/api`, `ENG`).
 */
export function placeSearchTerm(place: Pick<PresencePlaceWire, "subject" | "label" | "service">): string {
  if (place.service === "slack") {
    const channel = SLACK_CHANNEL_PREFIX.exec(place.subject)?.[1];
    if (channel !== undefined) return channel;
  }
  return place.label;
}

/** An exact filter's values: `eq` gives one, `in` gives a list. Other ops
 * name no single place. It mirrors the server's `exactValues`
 * (packages/api/src/services/presence-places.ts). */
function exactValues(filters: readonly EventSubscriptionFilterWire[], field: string): string[] {
  const values: string[] = [];
  for (const filter of filters) {
    if (filter.field !== field || (filter.op !== "eq" && filter.op !== "in")) continue;
    for (const value of Array.isArray(filter.value) ? filter.value : [filter.value]) {
      if (value !== "") values.push(value);
    }
  }
  return values;
}

/**
 * The mid-grain places of `places` that a line of presence names by its
 * `channel`, `repo`, or `team` filter. A channel filter holds the channel
 * id, so it matches the place key, not the label.
 */
export function placeSubjectsForRule(
  rule: { filters: readonly EventSubscriptionFilterWire[] },
  places: readonly PresencePlaceWire[],
): string[] {
  const channels = new Set(exactValues(rule.filters, "channel"));
  const repos = new Set(exactValues(rule.filters, "repo").map((repo) => `github:${repo.toLowerCase()}`));
  const teams = new Set(exactValues(rule.filters, "team").map((team) => `linear:team/${team}`));
  const subjects: string[] = [];
  for (const place of places) {
    if (!isMidGrain(place)) continue;
    const channel = SLACK_CHANNEL.exec(place.subject)?.[1];
    const named = (channel !== undefined && channels.has(channel)) || repos.has(place.subject) || teams.has(place.subject);
    if (named && !subjects.includes(place.subject)) subjects.push(place.subject);
  }
  return subjects;
}
