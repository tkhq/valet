import { mcpActionPlugin } from '@valet/sdk/mcp';
import type { ValetPlugin } from '@valet/engine';

const plugin: ValetPlugin = {
  name: 'typefully',
  version: '0.1.0',
  description: 'Typefully integration for social media content management',
  actions: [
    mcpActionPlugin({
      mcpUrl: 'https://mcp.typefully.com/mcp',
      serviceName: 'typefully',
      defaultRiskLevel: 'medium',
      authQueryParam: 'TYPEFULLY_API_KEY',
    }),
  ],
  credentials: [
    { type: 'api_key', configKeys: ['accessToken'], connectLabel: 'Typefully API key' },
  ],
};

export default plugin;
