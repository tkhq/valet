import { mcpActionPlugin } from '@valet/sdk/mcp';
import type { ValetPlugin } from '@valet/engine';

const plugin: ValetPlugin = {
  name: 'cloudflare',
  version: '0.1.0',
  description: 'Cloudflare integration for DNS, zones, and workers',
  actions: [
    mcpActionPlugin({
      mcpUrl: 'https://mcp.cloudflare.com/mcp',
      serviceName: 'cloudflare',
      defaultRiskLevel: 'medium',
    }),
  ],
  credentials: [{ type: 'oauth2', configKeys: ['accessToken'] }],
};

export default plugin;
