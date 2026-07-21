import { mcpActionPlugin } from '@valet/sdk/mcp';
import type { ValetPlugin } from '@valet/engine';

const plugin: ValetPlugin = {
  name: 'notion',
  version: '0.1.0',
  description: 'Notion integration for pages, databases, and workspaces',
  actions: [
    mcpActionPlugin({
      mcpUrl: 'https://mcp.notion.com/mcp',
      serviceName: 'notion',
      defaultRiskLevel: 'medium',
    }),
  ],
  credentials: [
    {
      type: 'oauth2',
      configKeys: ['accessToken'],
      oauth: { mode: 'mcp', serverUrl: 'https://mcp.notion.com/mcp' },
    },
  ],
};

export default plugin;
