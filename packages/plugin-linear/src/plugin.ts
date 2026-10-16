import { mcpActionPlugin } from '@valet/sdk/mcp';
import type { ValetPlugin } from '@valet/engine';
import { linearConnectionRoutes } from './connection.js';
import { LINEAR_TEAMS_SOURCE, makeLinearTeamsResolver } from './filter-options.js';
import { linearHttpRoutes } from './http.js';
import { linearTemplates } from './templates.js';
import { linearTriggerDefs } from './triggers.js';

// The app identity is the org Linear app connection's `actor=app` token
// (docs/specs/2026-10-15-native-integration-credential-policy-design.md Part C).
const LINEAR_APP_CREDENTIAL_SERVICE = 'linear:app';

const plugin: ValetPlugin = {
  name: 'linear',
  version: '0.1.0',
  description: 'Linear integration for issue tracking and project management',
  native: true,
  appCredentialService: LINEAR_APP_CREDENTIAL_SERVICE,
  actions: [
    mcpActionPlugin({
      mcpUrl: 'https://mcp.linear.app/mcp',
      serviceName: 'linear',
      defaultRiskLevel: 'medium',
      appCredentialService: LINEAR_APP_CREDENTIAL_SERVICE,
    }),
  ],
  triggers: linearTriggerDefs,
  httpRoutes: [...linearHttpRoutes, ...linearConnectionRoutes],
  templates: linearTemplates,
  filterOptionResolvers: {
    [LINEAR_TEAMS_SOURCE]: makeLinearTeamsResolver(),
  },
  credentials: [
    {
      type: 'oauth2',
      configKeys: ['accessToken'],
      oauth: { mode: 'mcp', serverUrl: 'https://mcp.linear.app/mcp' },
    },
  ],
};

export default plugin;
