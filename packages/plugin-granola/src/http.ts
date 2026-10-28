import type { PluginHttpRoute } from '@valet/engine';
import { inspectGranolaDelivery } from './triggers.js';

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
  verify(request, secrets, triggers) {
    // One inspection with one clock reading decides both the outcome and the
    // rejection. Two reads could disagree at the timestamp boundary and turn a
    // retryable stale delivery into an acknowledged one, which Granola never resends.
    const result = inspectGranolaDelivery(request, secrets.signingSecret, Date.now());
    if (!result.ok) return { accepted: false, rejection: result.rejection };
    const trigger = triggers.find((candidate) => candidate.id === 'granola.note');
    if (!trigger) {
      return { accepted: false, rejection: { reason: 'unsupported_event', detail: 'The Granola trigger is not loaded.', retry: true } };
    }
    const { eventType, deliveryId, payload } = result;
    return { accepted: true, events: [trigger.toEvent({ eventType, deliveryId, payload })] };
  },
}];
