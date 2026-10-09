/**
 * Host capabilities for the Slack plugin's HTTP routes. Storage stays in the
 * API tables: the org credential and `slack_webhook_inbox`. Each capability
 * is bound to one request. The host selects the organization, so no method
 * accepts an organization or user ID.
 */
import type { PluginHttpCaller, PluginHttpRequest } from '@valet/engine';
import {
  handleSlackApp,
  handleSlackEvents,
  type SlackAppSetupResponse,
  type SlackIngressCapability,
  type SlackSetupCapability,
} from '@valet/plugin-slack/http';
import type { Providers } from '../providers/types.js';
import type { GetSlackAppResponse } from '../wire/types.js';
import { resolveOrgId } from '../lib/org.js';
import { publicUrlFromEnv } from '../channels/host.js';
import { admitSlackDelivery, throttledDropLog } from '../channels/slack-inbox.js';
import { slackManifestEndpoints } from '../services/slack-app.js';
import type { PluginHttpBinding } from './http-bindings.js';

/** Compile-time check: the plugin's setup response satisfies the web client's wire type. */
export const slackSetupWireParity: (body: SlackAppSetupResponse) => GetSlackAppResponse = (body) => body;

export function slackIngressCapability(providers: Providers, request: PluginHttpRequest): SlackIngressCapability {
  const { db } = providers;
  let orgId: string | undefined;
  let ready: { orgId: string; webhookSecret: string; credentialTeamId: string } | undefined;
  return {
    async connection() {
      // Single-org deployment (`lib/org.ts`). The request body cannot select an organization.
      orgId = await resolveOrgId(db);
      const credential = await providers.engineCredentials.get({ type: 'org', id: orgId }, 'slack');
      const webhookSecret = typeof credential?.metadata?.webhookSecret === 'string' ? credential.metadata.webhookSecret : undefined;
      const credentialTeamId = typeof credential?.metadata?.teamId === 'string' ? credential.metadata.teamId : undefined;
      if (!credential || !webhookSecret || !credentialTeamId) return { state: 'unconfigured' };
      if (!providers.channelHost.transportFor('slack')) return { state: 'starting' };
      ready = { orgId, webhookSecret, credentialTeamId };
      return { state: 'ready', signingSecret: webhookSecret };
    },
    async report(problem) {
      try {
        await throttledDropLog(db, { orgId: orgId ?? await resolveOrgId(db), reason: problem.reason, detail: problem.detail });
      } catch (err) {
        console.error('[slack-webhook] problem diagnostic failed', err);
      }
    },
    async admit(delivery) {
      if (!ready) throw new Error('Read a ready Slack connection before admitting a delivery.');
      // The host stores its own copy of the bytes and headers it received.
      await admitSlackDelivery(providers, {
        ...ready, headers: request.headers, rawBody: request.rawBody,
        updates: delivery.updates, retryNum: delivery.retryNum, retryReason: delivery.retryReason,
      });
    },
  };
}

export function slackSetupCapability(providers: Providers, caller: PluginHttpCaller): SlackSetupCapability {
  return {
    async connection() {
      const credential = await providers.engineCredentials.get({ type: 'org', id: caller.orgId }, 'slack');
      if (!credential) return null;
      const metadata = credential.metadata;
      return {
        teamName: typeof metadata?.teamName === 'string' ? metadata.teamName : undefined,
        teamId: typeof metadata?.teamId === 'string' ? metadata.teamId : undefined,
        grantedScopes: credential.scopes,
      };
    },
    endpoints: () => slackManifestEndpoints(publicUrlFromEnv(process.env) ?? null),
  };
}

export const slackHttpBindings: Readonly<Record<string, PluginHttpBinding>> = {
  events: {
    auth: 'public',
    bind: ({ providers, request }) => handleSlackEvents(request, slackIngressCapability(providers, request)),
  },
  app: {
    auth: 'org-admin',
    bind: async ({ providers, request, caller }) => {
      if (!caller) throw new Error('Slack setup requires an authenticated caller. Check the route authentication.');
      return handleSlackApp(request, slackSetupCapability(providers, caller));
    },
  },
};
