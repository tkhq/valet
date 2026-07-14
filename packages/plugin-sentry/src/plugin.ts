import { mcpActionPlugin } from '@valet/sdk/mcp';
import type { ValetPlugin } from '@valet/engine';

const plugin: ValetPlugin = {
  name: 'sentry',
  version: '0.1.0',
  description: 'Sentry integration for error tracking and monitoring',
  actions: [
    mcpActionPlugin({
      mcpUrl: 'https://mcp.sentry.dev/mcp',
      serviceName: 'sentry',
      defaultRiskLevel: 'medium',
    }),
  ],
  credentials: [{ type: 'oauth2', configKeys: ['accessToken'] }],
};

export default plugin;
