import { Link } from "@tanstack/react-router";
import { useOnePasswordSettings } from "~/api/onepassword";
import { ErrorRow, LoadingRow } from "~/components/primitives";
import { Section } from "~/components/settings/section";
import { ServiceIcon } from "~/components/service-icon";
import { OnePasswordTokenRow } from "~/components/integrations/onepassword-setup";

/**
 * Organization · 1Password: the service-account token the whole org shares.
 * Only an org admin opens this page (the organization route guard), and
 * sets the token here.
 *
 * Your OWN token is not here. It is a personal credential, so it sits with
 * your other connections on Integrations. Both pages open the same setup
 * dialog, so the instructions read the same wherever you start.
 */

const REMOVE_ORG_TOKEN_NOTE =
  "This token is shared across the organization. Credentials that read their secret through it " +
  "stop resolving for every member. An admin can connect a new token here.";

export function OnePasswordPanel() {
  const settingsQ = useOnePasswordSettings();

  return (
    <Section
      title="1Password"
      description="Connect a service account, and agents read credentials from your vaults instead of you pasting them."
    >
      <div className="flex items-start gap-3 py-4">
        <ServiceIcon slug="1password" label="1Password" />
        <p className="text-sm text-muted">
          The organization token reads vaults every member's runtimes can use. Your own token
          is on{" "}
          <Link className="text-moss underline" to="/settings/integrations">
            Integrations
          </Link>
          .
        </p>
      </div>

      {settingsQ.isLoading && <LoadingRow />}
      {settingsQ.error && <ErrorRow>Failed to load 1Password settings. Reload the page to try again.</ErrorRow>}

      {settingsQ.data && (
        <OnePasswordTokenRow
          scope="org"
          connected={settingsQ.data.orgTokenConnected}
          label="Organization token"
          hint="A 1Password service account token shared across the organization."
          removeNote={REMOVE_ORG_TOKEN_NOTE}
        />
      )}
    </Section>
  );
}
