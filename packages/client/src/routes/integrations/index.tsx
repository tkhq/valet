import * as React from 'react';
import { createFileRoute, useNavigate } from '@tanstack/react-router';
import { useQueryClient } from '@tanstack/react-query';
import { PageContainer, PageHeader } from '@/components/layout/page-container';
import { IntegrationList } from '@/components/integrations/integration-list';
import { ConnectIntegrationDialog } from '@/components/integrations/connect-integration-dialog';
import { toastSuccess, toastError } from '@/hooks/use-toast';
import { githubKeys } from '@/api/github';
import { slackKeys, useClaimSlackUser } from '@/api/slack';
import { ApiError } from '@/api/client';

export const Route = createFileRoute('/integrations/')({
  component: IntegrationsPage,
  validateSearch: (
    search: Record<string, unknown>,
  ): { github?: string; slack_user?: string; reason?: string; claim?: string } => ({
    ...(typeof search.github === 'string' ? { github: search.github } : {}),
    ...(typeof search.slack_user === 'string' ? { slack_user: search.slack_user } : {}),
    ...(typeof search.reason === 'string' ? { reason: search.reason } : {}),
    ...(typeof search.claim === 'string' ? { claim: search.claim } : {}),
  }),
});

const REASON_LABELS: Record<string, string> = {
  missing_params: 'Missing parameters',
  invalid_state: 'Invalid or expired link — please try again',
  not_configured: 'OAuth is not configured by your admin',
  token_exchange_failed: 'Failed to exchange token',
  profile_fetch_failed: 'Could not fetch your profile',
  // slack-user specific
  user_mismatch: 'This Slack connection was started by a different Valet user',
  invalid_claim: 'Invalid or expired link — please try again',
  claim_expired: 'The connection link expired — please try again',
  integration_write_failed: 'Could not save the integration — please try again',
  oauth_http_error: 'Slack returned an HTTP error during token exchange',
  oauth_fetch_error: 'Could not reach Slack to exchange the OAuth code',
  oauth_failed: 'Slack rejected the OAuth exchange',
  missing_scopes: 'Workspace blocked one or more required Slack scopes',
  already_linked: 'That Slack user is already linked to a different Valet account',
};

function IntegrationsPage() {
  const [connectDialogOpen, setConnectDialogOpen] = React.useState(false);
  const { github, slack_user, reason, claim } = Route.useSearch();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const claimSlackUser = useClaimSlackUser();
  // Guard against double-redemption (React StrictMode double-fires effects).
  const claimStarted = React.useRef(false);

  React.useEffect(() => {
    if (!github && !slack_user) return;

    if (github === 'linked') {
      toastSuccess('GitHub connected', 'Your GitHub account has been linked.');
      qc.invalidateQueries({ queryKey: githubKeys.status });
    } else if (github === 'error') {
      toastError('GitHub linking failed', REASON_LABELS[reason ?? ''] ?? 'An unexpected error occurred.');
    }

    if (slack_user === 'claim' && claim) {
      // Final, authenticated step of the Slack (personal) connect flow: the
      // callback handed us an encrypted claim blob; redeem it so the worker
      // binds the credential to the signed-in user.
      if (!claimStarted.current) {
        claimStarted.current = true;
        claimSlackUser.mutate(claim, {
          onSuccess: (res) => {
            toastSuccess(
              'Slack (personal) connected',
              res.teamName
                ? `Your Slack account in ${res.teamName} has been linked.`
                : 'Your Slack account has been linked as a personal client.',
            );
          },
          onError: (err) => {
            const code = err instanceof ApiError ? err.code ?? '' : '';
            toastError(
              'Slack (personal) linking failed',
              REASON_LABELS[code] ?? 'An unexpected error occurred.',
            );
          },
        });
      }
    } else if (slack_user === 'linked') {
      toastSuccess('Slack (personal) connected', 'Your Slack account has been linked as a personal client.');
      qc.invalidateQueries({ queryKey: slackKeys.userOAuthStatus() });
    } else if (slack_user === 'error') {
      toastError('Slack (personal) linking failed', REASON_LABELS[reason ?? ''] ?? 'An unexpected error occurred.');
    }

    // Clear query params from URL (the claim blob especially should not
    // linger in the address bar).
    void navigate({ to: '/integrations', search: {}, replace: true });
  }, [github, slack_user, reason, claim, navigate, qc, claimSlackUser]);

  return (
    <PageContainer>
      <PageHeader
        title="Integrations"
        description="Connect your tools and services"
      />

      <IntegrationList
        onAddIntegration={() => setConnectDialogOpen(true)}
        addIntegrationLabel="Connect Integration"
      />

      <ConnectIntegrationDialog
        open={connectDialogOpen}
        onOpenChange={setConnectDialogOpen}
      />
    </PageContainer>
  );
}
