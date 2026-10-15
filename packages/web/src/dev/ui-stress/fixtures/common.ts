/**
 * Shared stress values for the UI stress gallery fixtures. Names are neutral
 * ("Team Alpha", "member-01"): fixtures never name real people.
 */
import type { MeResponse, OrgResponse, TeamSummary } from "@valet/api/wire";

/** A string that exists only in these fixtures. The production bundle check
 * greps `packages/web/dist` for it and must find nothing. */
export const UI_STRESS_MARKER = "uistress-fixture-marker-5c1e7a";

/** Fixture times count back from module load, so relative labels stay real. */
export const NOW = Date.now();
export const MINUTE = 60_000;
export const HOUR = 60 * MINUTE;
export const DAY = 24 * HOUR;

/** `count` characters, cycling `unit`, with no break opportunity. */
export function unbroken(unit: string, count: number): string {
  return unit.repeat(Math.ceil(count / unit.length)).slice(0, count);
}

/** Words cycling `text` until exactly `count` characters. */
export function words(text: string, count: number): string {
  let out = text;
  while (out.length < count) out += ` ${text}`;
  return out.slice(0, count).trimEnd();
}

/** A 300-character hex hash with no break opportunity. */
export const HEX_300 = unbroken("9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08", 300);

/** A 300-character URL with no break opportunity. */
export const URL_300 = `https://artifacts.example.com/builds/${unbroken("a1b2c3d4e5f6", 300 - 37)}`;

export const LOREM = "Deploy the staging migration, rotate the shared credentials, and post the release summary to the incident channel before the freeze window starts";

export const TITLE_400 = words(LOREM, 400);

export const STRING_2000 = words("The quick brown automation reads every repository and writes a very long report", 2000);

export const EMOJI = "🚀🔥✅🧪👩‍💻🏳️‍🌈🧑🏽‍🚀";

export const RTL_ARABIC = "طلب موافقة على نشر التغييرات إلى بيئة الإنتاج";

export const RTL_HEBREW = "בקשת אישור לפריסת השינויים לסביבת הייצור";

/** A long service id and action id as a plugin can register them. */
export const LONG_SERVICE = "enterprise-resource-planning-connector-for-regional-finance-and-procurement-teams";
export const LONG_ACTION = "create_or_update_purchase_order_line_items_with_multi_currency_tax_breakdown";

/** JSON nested `depth` levels, with a 2,000-character string at the bottom. */
export function deepJson(depth: number): Record<string, unknown> {
  let node: Record<string, unknown> = { leaf: STRING_2000, url: URL_300, hash: HEX_300 };
  for (let level = depth; level > 0; level -= 1) {
    node = { [`level_${level}`]: node, sibling: [level, `value-${level}`, { flag: level % 2 === 0 }] };
  }
  return node;
}

const GREEK = [
  "Alpha", "Beta", "Gamma", "Delta", "Epsilon", "Zeta", "Eta", "Theta", "Iota", "Kappa",
  "Lambda", "Mu", "Nu", "Xi", "Omicron", "Pi", "Rho", "Sigma", "Tau", "Upsilon",
  "Phi", "Chi", "Psi", "Omega", "Aleph", "Bet", "Gimel", "Dalet", "He", "Vav",
];

/** A team name for index `i`. Every third one is very long. */
export function teamName(i: number): string {
  const base = `Team ${GREEK[i % GREEK.length]}`;
  if (i % 3 === 1) return `${base} Platform Reliability, Incident Response and Developer Productivity Working Group for EMEA and APAC Regions`;
  if (i % 3 === 2) return `${base} ${EMOJI} ${unbroken("Infrastructure", 60)}`;
  return base;
}

export const TEAM_COUNT = 30;

export function teamId(i: number): string {
  return `team-${String(i).padStart(2, "0")}`;
}

export const stressTeams: TeamSummary[] = Array.from({ length: TEAM_COUNT }, (_, i) => ({
  id: teamId(i),
  orgId: "org-stress",
  name: teamName(i),
  origin: i % 5 === 0 ? "idp" : "local",
  externalId: i % 5 === 0 ? `/${unbroken("platform-group", 48)}-${i}` : null,
  createdAt: NOW - (i + 1) * DAY,
  memberCount: 3 + i * 7,
  callerRole: i % 4 === 0 ? "admin" : "member",
  defaultModel: null,
}));

export function memberId(i: number): string {
  return `member-${String(i).padStart(2, "0")}`;
}

/** The viewer. An org member, not an admin, so admin-only buttons render
 * their disabled state. */
export const stressMe: MeResponse = {
  id: memberId(0),
  email: "member-00@example.com",
  name: "member-00",
  avatarUrl: null,
  role: "member",
  orgId: "org-stress",
  orgRole: "member",
  defaultModel: null,
  defaultReasoning: null,
  newThreadBehavior: "keep_current",
  timezone: "UTC",
  timezoneReportDone: true,
};

export const stressOrg: OrgResponse = {
  id: "org-stress",
  name: `Stress Organization ${unbroken("Holdings", 40)}`,
  createdAt: NOW - 400 * DAY,
  features: { organizations: true, ssoTeamSync: true },
  ssoTeamGroups: ["/platform"],
  allowPublicArtifacts: false,
  plugins: [],
  callerRole: "member",
};
