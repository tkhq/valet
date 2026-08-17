/**
 * `github-org-app`: what `/integrations` may say about the organisation's
 * GitHub App.
 *
 * Two rules are under test. The copy must report the App's real state — a
 * fixed sentence that read the same with three installations and with no
 * App is what these functions replaced. And it must keep the two halves
 * apart: the personal credential and the org App are separate connections
 * with different identities, so no line may read as though connecting one
 * gives the other.
 *
 * The four states map to real conditions: no App at all (the personal
 * sign-in cannot start), an App nobody installed (the state a real user got
 * stuck in, because GitHub's creation flow ends without prompting for the
 * install), an App GitHub suspended everywhere, and a working install.
 */
import { describe, expect, it } from "vitest";
import type { GetGithubOrgStatusResponse } from "@valet/api/wire";
import { githubOrgApp, githubOrgAppState, githubOrgReachLines } from "./github-org-app";

function status(overrides: Partial<GetGithubOrgStatusResponse> = {}): GetGithubOrgStatusResponse {
  return { configured: true, installationCount: 1, suspendedCount: 0, ...overrides };
}

describe("githubOrgAppState", () => {
  it("separates no App from an App nobody installed", () => {
    expect(githubOrgAppState(status({ configured: false, installationCount: 0 }))).toBe("none");
    expect(githubOrgAppState(status({ installationCount: 0 }))).toBe("uninstalled");
  });

  it("reads an App suspended on every account as reaching nothing", () => {
    expect(githubOrgAppState(status({ installationCount: 2, suspendedCount: 2 }))).toBe("suspended");
  });

  it("stays installed while one account is still live", () => {
    expect(githubOrgAppState(status({ installationCount: 2, suspendedCount: 1 }))).toBe("installed");
  });
});

describe("githubOrgApp", () => {
  it("names the App's absence and why the personal sign-in depends on it", () => {
    const summary = githubOrgApp(status({ configured: false, installationCount: 0 }));
    expect(summary.badge.label).toBe("No org App");
    expect(summary.note).toContain("no GitHub App");
    expect(summary.note).toContain("signs you in to GitHub through that App");
  });

  it("states the missed install plainly, and names the corrective action for both readers", () => {
    const summary = githubOrgApp(status({ installationCount: 0 }));
    expect(summary.badge.label).toBe("Org App not installed");
    expect(summary.badge.variant).toBe("warning");
    expect(summary.note).toContain("nobody installed it on a GitHub account");
    expect(summary.adminAction).toBe("Finish the install");
    expect(summary.memberAction).toBe("Ask an org admin to install it.");
  });

  it("counts only the accounts the App can still reach", () => {
    expect(githubOrgApp(status({ installationCount: 3, suspendedCount: 1 })).note).toContain(
      "reaches 2 GitHub accounts",
    );
    expect(githubOrgApp(status({ installationCount: 1 })).note).toContain("reaches 1 GitHub account");
  });

  it("says whose identity the App carries, so it never reads as the user's connection", () => {
    expect(githubOrgApp(status()).note).toContain("acts as your organisation, not as you");
  });

  it("never reuses the badge that marks the personal credential", () => {
    // `success` is "Connected" on the same card. Two connections, two
    // colours — see `service-health.ts`.
    const variants = [
      githubOrgApp(status({ configured: false, installationCount: 0 })).badge.variant,
      githubOrgApp(status({ installationCount: 0 })).badge.variant,
      githubOrgApp(status({ installationCount: 1, suspendedCount: 1 })).badge.variant,
      githubOrgApp(status()).badge.variant,
    ];
    expect(variants).toEqual(["neutral", "warning", "danger", "accent"]);
  });

  it("leaves the member with nothing to chase once the App works", () => {
    expect(githubOrgApp(status()).memberAction).toBeNull();
  });
});

describe("githubOrgReachLines", () => {
  it("adds GitHub's org-wide path, which no other service has", () => {
    expect(githubOrgReachLines("github", status()).length).toBeGreaterThan(0);
    expect(githubOrgReachLines("gmail", status())).toEqual([]);
    expect(githubOrgReachLines("slack", status())).toEqual([]);
  });

  it("claims nothing while the org status is unknown", () => {
    // The card then states the personal reach alone, the same as every
    // other service — better than a guess about an App.
    expect(githubOrgReachLines("github", undefined)).toEqual([]);
  });

  it("tells a blocked reader that Continue cannot work, and what does", () => {
    const lines = githubOrgReachLines("github", status({ configured: false, installationCount: 0 }));
    expect(lines.join(" ")).toContain("Continue cannot reach GitHub yet");
    expect(lines.join(" ")).toContain("Enter a token instead");
  });

  it("keeps the two halves apart in every state where both can exist", () => {
    const separate = "it acts as you, and the App acts as your organisation";
    expect(githubOrgReachLines("github", status({ installationCount: 0 })).join(" ")).toContain(separate);
    expect(githubOrgReachLines("github", status({ installationCount: 1, suspendedCount: 1 })).join(" ")).toContain(
      separate,
    );
    expect(githubOrgReachLines("github", status()).join(" ")).toContain(separate);
  });

  it("says either half can reach a repository once the App is installed", () => {
    expect(githubOrgReachLines("github", status()).join(" ")).toContain(
      "Valet can reach a repository through either one",
    );
  });
});
