import type { IntegrationProvider, IntegrationCredentials, OAuthConfig } from '@valet/sdk';
import { FIGMA_API, figmaGet } from './api.js';

const FIGMA_AUTH = 'https://www.figma.com/oauth';

const FIGMA_SCOPES = ['file_content:read', 'current_user:read'];

interface FigmaTokenResponse {
  access_token: string;
  refresh_token?: string;
  expires_in: number;
  token_type: string;
}

async function requestToken(oauth: OAuthConfig, body: URLSearchParams): Promise<FigmaTokenResponse> {
  const res = await fetch(`${FIGMA_API}/oauth/token`, {
    method: 'POST',
    headers: {
      Authorization: `Basic ${btoa(`${oauth.clientId}:${oauth.clientSecret}`)}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body,
  });
  if (!res.ok) {
    throw new Error(`Figma token request failed (${res.status}): ${await res.text()}`);
  }
  return (await res.json()) as FigmaTokenResponse;
}

export const figmaProvider: IntegrationProvider = {
  service: 'figma',
  displayName: 'Figma',
  authType: 'oauth2',
  supportedEntities: ['files'],
  oauthScopes: FIGMA_SCOPES,
  oauthEnvKeys: { clientId: 'FIGMA_CLIENT_ID', clientSecret: 'FIGMA_CLIENT_SECRET' },

  validateCredentials(credentials: IntegrationCredentials): boolean {
    return !!(credentials.access_token || credentials.refresh_token);
  },

  async testConnection(credentials: IntegrationCredentials): Promise<boolean> {
    try {
      const res = await figmaGet('/me', credentials.access_token || '');
      return res.ok;
    } catch {
      return false;
    }
  },

  getOAuthUrl(oauth: OAuthConfig, redirectUri: string, state: string): string {
    const params = new URLSearchParams({
      client_id: oauth.clientId,
      redirect_uri: redirectUri,
      scope: FIGMA_SCOPES.join(' '),
      state,
      response_type: 'code',
    });
    return `${FIGMA_AUTH}?${params}`;
  },

  async exchangeOAuthCode(
    oauth: OAuthConfig,
    code: string,
    redirectUri: string,
  ): Promise<IntegrationCredentials> {
    const data = await requestToken(oauth, new URLSearchParams({
      redirect_uri: redirectUri,
      code,
      grant_type: 'authorization_code',
    }));
    return {
      access_token: data.access_token,
      refresh_token: data.refresh_token || '',
      expires_at: new Date(Date.now() + data.expires_in * 1000).toISOString(),
      token_type: data.token_type,
    };
  },

  async refreshOAuthTokens(
    oauth: OAuthConfig,
    refreshToken: string,
  ): Promise<IntegrationCredentials> {
    const data = await requestToken(oauth, new URLSearchParams({
      refresh_token: refreshToken,
      grant_type: 'refresh_token',
    }));
    return {
      access_token: data.access_token,
      refresh_token: data.refresh_token || refreshToken,
      expires_at: new Date(Date.now() + data.expires_in * 1000).toISOString(),
      token_type: data.token_type,
    };
  },
};
