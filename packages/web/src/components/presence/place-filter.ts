/**
 * The filter that names one place, read from its key. The wizard uses it to
 * open on a place: **Add** on a place page preselects the place's service and
 * this filter (docs/specs/2026-10-16-presence-hub-design.md Part B step 3).
 *
 * The keys follow the places API grammar: `slack:<team>/<channel>`,
 * `github:<owner>/<repo>[#<n>]`, `linear:team/<KEY>`, `linear:<ID>`. A
 * service-wide row (`slack:<team>`, `github:*`, `linear:*`) names no filter.
 */
import type { PresencePlaceService } from "@valet/api/wire";

/** The place a wizard opens on. `label` is the concrete name, such as `#incidents`. */
export interface PreselectedPlace {
  subject: string;
  service: PresencePlaceService;
  label: string;
}

export interface PlaceFilter {
  field: "channel" | "repo" | "team" | "identifier";
  value: string;
  label: string;
}

const SLACK_CHANNEL = /^slack:[^/]+\/([^/]+)$/;
const GITHUB_REPO = /^github:([^/#@]+\/[^/#@]+)(?:#\d+)?$/;
const LINEAR_TEAM = /^linear:team\/([A-Za-z0-9_-]+)$/;
const LINEAR_ISSUE = /^linear:(?!team\/)([A-Za-z0-9_-]+-\d+)$/;

/** The filter for a place, or null for a service-wide row. A pull request or
 * issue on GitHub names its repository, the place a listener filter takes. */
export function placeFilter(place: PreselectedPlace): PlaceFilter | null {
  const { subject, label } = place;
  const channel = SLACK_CHANNEL.exec(subject);
  if (channel) return { field: "channel", value: channel[1]!, label };
  const repo = GITHUB_REPO.exec(subject);
  if (repo) return { field: "repo", value: repo[1]!, label: repo[1]! };
  const team = LINEAR_TEAM.exec(subject);
  if (team) return { field: "team", value: team[1]!, label: team[1]! };
  const issue = LINEAR_ISSUE.exec(subject);
  if (issue) return { field: "identifier", value: issue[1]!, label: issue[1]! };
  return null;
}
