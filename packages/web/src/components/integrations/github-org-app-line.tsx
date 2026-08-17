/**
 * The organisation's half of GitHub, on the GitHub card in `/integrations`.
 *
 * One line: a badge naming the App's state, the state in words, and either
 * a link to the page that owns the App or the sentence for somebody who
 * cannot open that page. `github-org-app.ts` holds the copy and the reason
 * the two halves are described as separate connections.
 *
 * The line renders nothing until the status arrives. A card that guesses at
 * the org half — which is what a hardcoded sentence did — is the failure
 * this replaces, so an unanswered query says nothing rather than something
 * plausible.
 */
import { useOrg } from "~/api/settings";
import { useGithubOrgStatus } from "~/api/repos";
import { Badge } from "~/components/primitives";
import { githubOrgApp } from "./github-org-app";

export function GithubOrgAppLine() {
  const statusQ = useGithubOrgStatus();
  const orgQ = useOrg();

  if (!statusQ.data) return null;
  const summary = githubOrgApp(statusQ.data);

  // The same rule `SettingsRail` uses to show the Organization group.
  // Anybody else follows the link to "Organization settings are managed by
  // your org admins", so they read the corrective action instead.
  const canOpenAppPage =
    orgQ.data?.features.organizations === true && orgQ.data.callerRole === "admin";

  return (
    <p className="text-xs leading-relaxed text-muted">
      <Badge variant={summary.badge.variant} className="mr-1.5">
        {summary.badge.label}
      </Badge>
      {summary.note}{" "}
      {canOpenAppPage ? (
        <a
          href="/settings/organization/github"
          className="whitespace-nowrap text-ink underline underline-offset-2"
        >
          {summary.adminAction}
        </a>
      ) : (
        summary.memberAction
      )}
    </p>
  );
}
