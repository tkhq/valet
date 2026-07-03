import type { IntegrationPackage } from '@valet/sdk';
import { githubProvider } from './provider.js';
import { githubActions } from './actions.js';
import { githubTriggers } from './triggers.js';
import { githubTemplates } from './templates.js';

export { githubProvider } from './provider.js';
export { githubActions } from './actions.js';
export { githubTriggers } from './triggers.js';
export { githubTemplates } from './templates.js';
export { githubFetch } from './api.js';

const githubPackage: IntegrationPackage = {
  name: '@valet/actions-github',
  version: '0.0.1',
  service: 'github',
  provider: githubProvider,
  actions: githubActions,
  triggers: githubTriggers,
  templates: githubTemplates,
};

export default githubPackage;
