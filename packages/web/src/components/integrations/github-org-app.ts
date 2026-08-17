/**
 * What `/integrations` may say about the organisation's GitHub App.
 *
 * GitHub is the one service with two halves. A user connects a personal
 * credential here; the organisation separately owns a GitHub App, set up on
 * `/settings/organization/github`. The two are neither the same thing nor
 * independent:
 *
 *   - The App is a PREREQUISITE. `POST /api/me/github/connect` builds its
 *     authorize URL from the App's own OAuth client, so with no App the
 *     personal sign-in cannot start at all. A pasted token is the only path
 *     that works without one.
 *   - The two SUBSTITUTE at run time. `services/github-tokens.ts` resolves
 *     an installation token or a user credential, in an order that depends
 *     on the purpose, so either half alone can reach a repository.
 *   - They carry different identities. A session on the App acts as the
 *     organisation; a session on the personal credential acts as the user.
 *
 * `/integrations` used to state one static sentence for GitHub that read
 * the same whether the organisation had three installations or no App at
 * all. It also offered the same plain "Connect" in the state where that
 * button can only fail. Everything below is derived from
 * `GET /api/me/github/org-status`, so a card that says an App exists is
 * reading one, and a card with no data says nothing.
 *
 * The App's lifecycle — create, install, refresh, remove — stays on
 * `/settings/organization/github`. This module only reports and points.
 */
import type { GetGithubOrgStatusResponse } from "@valet/api/wire";

/** Where the org half stands, in the terms a reader can act on. */
export type GithubOrgAppState = "none" | "uninstalled" | "suspended" | "installed";

export function githubOrgAppState(status: GetGithubOrgStatusResponse): GithubOrgAppState {
  if (!status.configured) return "none";
  if (status.installationCount === 0) return "uninstalled";
  // A suspended installation reaches no repository, so an App suspended
  // everywhere is worth as much as an App nobody installed — and saying
  // "installed on 1 account" would read as working.
  if (status.suspendedCount >= status.installationCount) return "suspended";
  return "installed";
}

/** GitHub accounts the App can actually reach right now. */
function reach(status: GetGithubOrgStatusResponse): number {
  return Math.max(0, status.installationCount - status.suspendedCount);
}

function accounts(count: number): string {
  return `${count} GitHub ${count === 1 ? "account" : "accounts"}`;
}

export interface GithubOrgAppSummary {
  state: GithubOrgAppState;
  /** Never `success` — that variant marks the personal credential on the
   * same card, and one colour for two different connections is exactly the
   * conflation this module exists to prevent. */
  badge: { label: string; variant: "neutral" | "accent" | "warning" | "danger" };
  /** The state, in one or two sentences. */
  note: string;
  /** Link text for the org's App page. Show it only to an org admin: the
   * page is admin-gated, so anybody else follows it to a refusal. */
  adminAction: string;
  /** What somebody without admin rights can do instead. Null when the state
   * waits on nobody. */
  memberAction: string | null;
}

export function githubOrgApp(status: GetGithubOrgStatusResponse): GithubOrgAppSummary {
  const state = githubOrgAppState(status);
  switch (state) {
    case "none":
      return {
        state,
        badge: { label: "No org App", variant: "neutral" },
        note: "Your organisation has no GitHub App. Valet signs you in to GitHub through that App.",
        adminAction: "Set up the organisation's App",
        memberAction: "Ask an org admin to add one, or select Connect and enter a token instead.",
      };
    case "uninstalled":
      return {
        state,
        badge: { label: "Org App not installed", variant: "warning" },
        note: "Your organisation has a GitHub App, but nobody installed it on a GitHub account.",
        adminAction: "Finish the install",
        memberAction: "Ask an org admin to install it.",
      };
    case "suspended":
      return {
        state,
        badge: { label: "Org App suspended", variant: "danger" },
        note: "GitHub suspended your organisation's App on every account it is installed on. The App reaches no repository.",
        adminAction: "Review the App",
        memberAction: "Ask an org admin to restore it on GitHub.",
      };
    case "installed":
      return {
        state,
        badge: { label: "Org App installed", variant: "accent" },
        note: `Your organisation's GitHub App reaches ${accounts(reach(status))}. It acts as your organisation, not as you.`,
        adminAction: "Manage the App",
        memberAction: null,
      };
  }
}

/**
 * The org half for the pre-connect screen's "Who can reach it" card, where
 * there is room to say how the two halves relate and what to do when the
 * personal path is blocked.
 *
 * Returns nothing for a service with no org half, and nothing while the
 * status is unknown — the card then states the personal reach alone, which
 * is what every other service shows.
 */
export function githubOrgReachLines(
  service: string,
  status: GetGithubOrgStatusResponse | undefined,
): string[] {
  if (service !== "github" || !status) return [];

  const separate =
    "This connection is a separate thing: it acts as you, and the App acts as your organisation.";

  switch (githubOrgAppState(status)) {
    case "none":
      return [
        "Your organisation has no GitHub App.",
        "Valet signs you in to GitHub through that App, so Continue cannot reach GitHub yet.",
        "Select 'Enter a token instead' to use a personal access token.",
      ];
    case "uninstalled":
      return [
        "Your organisation has a GitHub App, but nobody installed it on a GitHub account.",
        "The App reaches no repository until somebody installs it.",
        separate,
      ];
    case "suspended":
      return [
        "GitHub suspended your organisation's App on every account it is installed on.",
        "The App reaches no repository while it stays suspended.",
        separate,
      ];
    case "installed":
      return [
        `Your organisation's GitHub App reaches ${accounts(reach(status))}.`,
        separate,
        "Valet can reach a repository through either one.",
      ];
  }
}
