import { mcpActionPlugin } from '@valet/sdk/mcp';
import type { ValetPlugin } from '@valet/engine';
import { LINEAR_TEAMS_SOURCE, makeLinearTeamsResolver } from './filter-options.js';
import { linearTemplates } from './templates.js';
import { linearTriggerDefs } from './triggers.js';

const plugin: ValetPlugin = {
  name: 'linear',
  version: '0.1.0',
  description: 'Linear integration for issue tracking and project management',
  actions: [
    mcpActionPlugin({
      mcpUrl: 'https://mcp.linear.app/mcp',
      serviceName: 'linear',
      defaultRiskLevel: 'medium',
    }),
  ],
  triggers: linearTriggerDefs,
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
