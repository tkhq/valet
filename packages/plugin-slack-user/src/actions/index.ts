import type { IntegrationPackage } from '@valet/sdk';
import { slackUserProvider } from './provider.js';
import { slackUserActions } from './actions.js';

export { slackUserProvider, SLACK_USER_SCOPES } from './provider.js';
export { slackUserActions } from './actions.js';
export { slackFetch, slackGet, isRevokedError, reconnectError, notConnectedError } from './api.js';

const slackUserPackage: IntegrationPackage = {
  name: '@valet/actions-slack-user',
  version: '0.0.1',
  service: 'slack-user',
  provider: slackUserProvider,
  actions: slackUserActions,
};

export default slackUserPackage;
