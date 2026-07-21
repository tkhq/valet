import { mcpActionPlugin } from '@valet/sdk/mcp';
import type { ValetPlugin } from '@valet/engine';

const plugin: ValetPlugin = {
  name: 'stripe',
  version: '0.1.0',
  description: 'Stripe integration for payments, customers, and subscriptions',
  actions: [
    mcpActionPlugin({
      mcpUrl: 'https://mcp.stripe.com/mcp',
      serviceName: 'stripe',
      defaultRiskLevel: 'medium',
    }),
  ],
  credentials: [
    {
      type: 'oauth2',
      configKeys: ['accessToken'],
      oauth: { mode: 'mcp', serverUrl: 'https://mcp.stripe.com/mcp' },
    },
  ],
};

export default plugin;
