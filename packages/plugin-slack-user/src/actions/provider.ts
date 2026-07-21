import type { IntegrationProvider, IntegrationCredentials, OAuthConfig } from '@valet/sdk';

const SLACK_API = 'https://slack.com/api';
const SLACK_AUTHORIZE = 'https://slack.com/oauth/v2/authorize';

/**
 * Full user-scope bundle for the `slack-user` integration.
 *
 * A single scope set covering both read/search and write/act-as on behalf of
 * the user:
 *   - read / search:  read history across the user's full visible surface
 *                     (public + private channels, DMs, group DMs), plus
 *                     search.messages, user/team metadata.
 *   - write / act-as: post on behalf of the user, set status / DND,
 *                     reactions, files, pins, bookmarks, stars, reminders,
 *                     usergroups, emoji.
 *
 * EXCLUDED on purpose:
 *   - bot-only scopes (e.g. chat:write.customize)
 *   - search:read.enterprise
 *   - admin.* scopes
 *
 * Requested in a single consent at connect time so the full surface is
 * available without a re-consent round trip. The Slack app workspace install
 * MUST be refreshed for these to take effect — see slack-user-app-manifest.json
 * and the matching update to plugin-slack/slack-app-manifest.json.
 */
export const SLACK_USER_SCOPES: readonly string[] = [
  // ── read / search ──
  'search:read',
  'channels:history',
  'groups:history',
  'im:history',
  'mpim:history',
  'channels:read',
  'groups:read',
  'im:read',
  'mpim:read',
  'users:read',
  'users.profile:read',
  'team:read',

  // ── write / act-as ──
  'chat:write',
  // conversations.open (send_dm) needs write scope to open the IM/MPIM channel
  // before chat.postMessage can deliver to it.
  'im:write',
  'mpim:write',
  'users.profile:write',
  'reactions:write',
  'reactions:read',
  'dnd:write',
  'dnd:read',
  'files:read',
  'files:write',
  'pins:read',
  'pins:write',
  'bookmarks:read',
  'bookmarks:write',
  'stars:read',
  'stars:write',
  'reminders:read',
  'reminders:write',
  'usergroups:read',
  'usergroups:write',
  'emoji:read',
] as const;

export const slackUserProvider: IntegrationProvider = {
  service: 'slack-user',
  displayName: 'Slack (personal)',
  authType: 'oauth2',
  // Per-user xoxp token — independent from the org bot integration.
  credentialScope: 'user',
  supportedEntities: ['channels', 'messages', 'users', 'profile'],
  oauthScopes: [...SLACK_USER_SCOPES],
  // Shares the org bot's Slack app credentials — the app manifest declares
  // both bot scopes and user scopes. See packages/plugin-slack/slack-app-manifest.json.
  oauthEnvKeys: { clientId: 'SLACK_CLIENT_ID', clientSecret: 'SLACK_CLIENT_SECRET' },

  validateCredentials(credentials: IntegrationCredentials): boolean {
    return !!credentials.access_token;
  },

  async testConnection(credentials: IntegrationCredentials): Promise<boolean> {
    try {
      const token = credentials.access_token || '';
      if (!token) return false;
      const res = await fetch(`${SLACK_API}/auth.test`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json; charset=utf-8',
        },
        body: '{}',
      });
      if (!res.ok) return false;
      const data = (await res.json()) as { ok: boolean };
      return data.ok === true;
    } catch {
      return false;
    }
  },

  /**
   * Slack OAuth v2 distinguishes between `scope` (bot scopes) and `user_scope`
   * (user scopes that produce the xoxp token returned under `authed_user`).
   * Because slack-user requests user scopes only, we set user_scope and leave
   * the bot `scope` parameter empty.
   */
  getOAuthUrl(oauth: OAuthConfig, redirectUri: string, state: string): string {
    const params = new URLSearchParams({
      client_id: oauth.clientId,
      redirect_uri: redirectUri,
      state,
      scope: '',
      user_scope: SLACK_USER_SCOPES.join(','),
    });
    return `${SLACK_AUTHORIZE}?${params}`;
  },

  /**
   * Exchange the OAuth code, returning the user's xoxp token. The actual
   * `authed_user.access_token` extraction + metadata capture happens in the
   * worker route (so it can also persist team_id / slack_user_id metadata).
   * This method is provided for IntegrationProvider conformance and for the
   * generic OAuth path; the slack-user route does its own exchange.
   *
   * Slack user tokens are long-lived (no rotation), so no refresh path is
   * implemented or needed.
   */
  async exchangeOAuthCode(
    oauth: OAuthConfig,
    code: string,
    redirectUri: string,
  ): Promise<IntegrationCredentials> {
    const res = await fetch(`${SLACK_API}/oauth.v2.access`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: oauth.clientId,
        client_secret: oauth.clientSecret,
        code,
        redirect_uri: redirectUri,
      }).toString(),
    });
    if (!res.ok) {
      throw new Error(`oauth.v2.access HTTP ${res.status}`);
    }
    const data = (await res.json()) as {
      ok: boolean;
      error?: string;
      authed_user?: { id?: string; access_token?: string; scope?: string };
      team?: { id?: string; name?: string };
    };
    if (!data.ok || !data.authed_user?.access_token) {
      throw new Error(`oauth.v2.access failed: ${data.error || 'no user token'}`);
    }
    return {
      access_token: data.authed_user.access_token,
      scope: data.authed_user.scope || '',
      slack_user_id: data.authed_user.id || '',
      team_id: data.team?.id || '',
      team_name: data.team?.name || '',
    };
  },
};
