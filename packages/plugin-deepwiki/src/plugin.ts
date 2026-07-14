import { mcpActionPlugin } from '@valet/sdk/mcp';
import type { ValetPlugin } from '@valet/engine';

const plugin: ValetPlugin = {
  name: 'deepwiki',
  version: '0.1.0',
  description: 'DeepWiki integration for repository knowledge base',
  actions: [
    mcpActionPlugin({
      mcpUrl: 'https://mcp.deepwiki.com/mcp',
      serviceName: 'deepwiki',
      defaultRiskLevel: 'low',
      noAuth: true,
    }),
  ],
};

export default plugin;
