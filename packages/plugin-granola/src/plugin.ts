import type { ValetPlugin } from '@valet/engine';
import { granolaHttpRoutes } from './http.js';
import { granolaTriggerDefs } from './triggers.js';

// Event source only. Granola's MCP tools are not declared here: an operator
// can still add them as a config-declared MCP server named `granola`.
const plugin: ValetPlugin = {
  name: 'granola',
  version: '0.1.0',
  displayName: 'Granola',
  description: 'Granola note webhook events for workflow triggers',
  triggers: granolaTriggerDefs,
  httpRoutes: granolaHttpRoutes,
};

export default plugin;
