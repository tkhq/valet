/**
 * Place helpers the Presence overview and pages share
 * (docs/specs/2026-10-16-presence-hub-design.md Part B). The places API
 * returns every grain. The overview keeps the service-wide rows and the mid
 * grain: Slack channels, GitHub repositories, and Linear teams.
 */
import type { PresencePlaceService, PresencePlaceWire } from "@valet/api/wire";

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
