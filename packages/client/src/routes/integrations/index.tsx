import * as React from 'react';
import { createFileRoute, useNavigate } from '@tanstack/react-router';
import { useQueryClient } from '@tanstack/react-query';
import { PageContainer, PageHeader } from '@/components/layout/page-container';
import { IntegrationList } from '@/components/integrations/integration-list';
import { ConnectIntegrationDialog } from '@/components/integrations/connect-integration-dialog';
import { toastSuccess, toastError } from '@/hooks/use-toast';
import { githubKeys } from '@/api/github';
import { slackKeys } from '@/api/slack';

export const Route = createFileRoute('/integrations/')({
  component: IntegrationsPage,
  validateSearch: (
    search: Record<string, unknown>,
  ): { github?: string; slack_user?: string; reason?: string } => ({
    ...(typeof search.github === 'string' ? { github: search.github } : {}),
    ...(typeof search.slack_user === 'string' ? { slack_user: search.slack_user } : {}),
    ...(typeof search.reason === 'string' ? { reason: search.reason } : {}),
  }),
});

const REASON_LABELS: Record<string, string> = {
  missing_params: 'Missing parameters',
  invalid_state: 'Invalid or expired link — please try again',
  not_configured: 'OAuth is not configured by your admin',
  token_exchange_failed: 'Failed to exchange token',
  profile_fetch_failed: 'Could not fetch your profile',
  // slack-user specific
  user_mismatch: 'Sign-in session did not match the OAuth request',
  oauth_http_error: 'Slack returned an HTTP error during token exchange',
  oauth_fetch_error: 'Could not reach Slack to exchange the OAuth code',
  oauth_failed: 'Slack rejected the OAuth exchange',
  missing_scopes: 'Workspace blocked one or more required Slack scopes',
  already_linked: 'That Slack user is already linked to a different Valet account',
};

function IntegrationsPage() {
  const [connectDialogOpen, setConnectDialogOpen] = React.useState(false);
  const { github, slack_user, reason } = Route.useSearch();
  const navigate = useNavigate();
  const qc = useQueryClient();

  React.useEffect(() => {
    if (!github && !slack_user) return;

    if (github === 'linked') {
      toastSuccess('GitHub connected', 'Your GitHub account has been linked.');
      qc.invalidateQueries({ queryKey: githubKeys.status });
    } else if (github === 'error') {
      toastError('GitHub linking failed', REASON_LABELS[reason ?? ''] ?? 'An unexpected error occurred.');
    }

    if (slack_user === 'linked') {
      toastSuccess('Slack (personal) connected', 'Your Slack account has been linked as a personal client.');
      qc.invalidateQueries({ queryKey: slackKeys.userOAuthStatus() });
    } else if (slack_user === 'error') {
      toastError('Slack (personal) linking failed', REASON_LABELS[reason ?? ''] ?? 'An unexpected error occurred.');
    }

    // Clear query params from URL
    void navigate({ to: '/integrations', search: {}, replace: true });
  }, [github, slack_user, reason, navigate, qc]);

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
