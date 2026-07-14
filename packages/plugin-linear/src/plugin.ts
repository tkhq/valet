import { mcpActionPlugin } from '@valet/sdk/mcp';
import type { ValetPlugin } from '@valet/engine';

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
  credentials: [{ type: 'oauth2', configKeys: ['accessToken'] }],
};

export default plugin;
