import { describe, it, expect } from 'vitest';
import { validateValetPlugin } from '@valet/engine';
import plugin from './plugin.js';

describe('figma plugin manifest', () => {
  it('is a valid v2 plugin', () => {
    expect(validateValetPlugin(plugin)).toMatchObject({ ok: true });
  });

  it('connects only through Figma OAuth with Basic client auth and a separate refresh URL', () => {
    const [cred] = plugin.credentials ?? [];
    expect(cred).toMatchObject({ type: 'oauth2', service: 'figma', oauthOnly: true, scopes: ['file_content:read'] });
    expect(cred?.oauth).toMatchObject({
      mode: 'authorization_code',
      tokenUrl: 'https://api.figma.com/v1/oauth/token',
      refreshUrl: 'https://api.figma.com/v1/oauth/refresh',
      tokenAuth: 'client_secret_basic',
      clientIdEnv: 'FIGMA_CLIENT_ID',
      clientSecretEnv: 'FIGMA_CLIENT_SECRET',
    });
  });
});
