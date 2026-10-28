import type { PluginHttpRoute } from '@valet/engine';

const ORG_ID = /^[\w-]{1,128}$/;

/**
 * Granola's payload names no workspace, so the URL carries the organization
 * ID. The ID only picks the signing secret. The signature authenticates the
 * delivery. Granola retries on 408, 429, and 5xx and fails permanently on
 * other 4xx, so a signed event Valet does not handle is acknowledged with 200.
 */
export const granolaHttpRoutes: PluginHttpRoute[] = [{
  id: 'events', method: 'POST', path: '/events/:orgId', auth: 'signature',
  maxBodyBytes: 64 * 1024, acknowledgementStatus: 200,
  installationKey: (request) => ORG_ID.test(request.params.orgId ?? '') ? request.params.orgId : null,
  async verify(request, secrets, triggers) {
    for (const trigger of triggers) {
      const verified = await trigger.verify(request, secrets);
      if (verified) return { accepted: true, events: [trigger.toEvent(verified)] };
    }
    const explainer = triggers.find((trigger) => trigger.explainRejection);
    const rejection = await explainer?.explainRejection?.(request, secrets)
      ?? { reason: 'bad_signature', detail: 'service=granola' };
    return { accepted: false, rejection };
  },
}];
