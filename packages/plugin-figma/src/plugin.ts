import { mcpActionPlugin } from '@valet/sdk/mcp';
import type { ValetPlugin } from '@valet/engine';

const plugin: ValetPlugin = {
  name: 'figma',
  version: '0.1.0',
  description: 'Figma integration for design context, screenshots, and code connect',
  actions: [
    mcpActionPlugin({
      mcpUrl: 'https://mcp.figma.com/mcp',
      serviceName: 'figma',
      defaultRiskLevel: 'medium',
    }),
  ],
  credentials: [
    {
      type: 'oauth2',
      configKeys: ['accessToken'],
      oauth: { mode: 'mcp', serverUrl: 'https://mcp.figma.com/mcp' },
    },
  ],
};

export default plugin;
