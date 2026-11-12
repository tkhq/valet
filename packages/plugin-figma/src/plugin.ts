import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { loadSkillFromMarkdown, type ValetPlugin } from '@valet/engine';
import { figmaPlugin } from './actions/actions.js';

const skillMd = readFileSync(fileURLToPath(new URL('../skills/figma.md', import.meta.url)), 'utf8');

/**
 * Figma's hosted MCP server admits only OAuth clients that Figma approves, so
 * this plugin calls the Figma REST API directly with a Figma OAuth app. The
 * host needs FIGMA_CLIENT_ID and FIGMA_CLIENT_SECRET from a private Figma
 * OAuth app whose redirect URL is this instance's
 * /api/credentials/oauth/callback. Figma authenticates the client with HTTP
 * Basic and refreshes at a separate URL; a refresh returns no new refresh
 * token, so the stored one is kept.
 */
const plugin: ValetPlugin = {
  name: 'figma',
  version: '0.2.0',
  description: "Figma integration that renders frames to images and lists a file's frames",
  actions: [figmaPlugin],
  skills: [loadSkillFromMarkdown(skillMd, 'plugin', 'figma')],
  credentials: [
    {
      type: 'oauth2',
      service: 'figma',
      scopes: ['file_content:read'],
      configKeys: ['accessToken', 'refreshToken'],
      connectLabel: 'Connect Figma',
      oauthOnly: true,
      oauth: {
        mode: 'authorization_code',
        authorizationUrl: 'https://www.figma.com/oauth',
        tokenUrl: 'https://api.figma.com/v1/oauth/token',
        refreshUrl: 'https://api.figma.com/v1/oauth/refresh',
        tokenAuth: 'client_secret_basic',
        clientIdEnv: 'FIGMA_CLIENT_ID',
        clientSecretEnv: 'FIGMA_CLIENT_SECRET',
      },
    },
  ],
};

export default plugin;
