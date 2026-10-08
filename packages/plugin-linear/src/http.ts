import type { PluginHttpRoute } from '@valet/engine';

/** Linear counts only HTTP 200 as delivered, including unsupported signed events. */
export const linearHttpRoutes: PluginHttpRoute[] = [{
  id: 'events', method: 'POST', path: '/events', auth: 'signature',
  maxBodyBytes: 1024 * 1024, acknowledgementStatus: 200,
  installationKey(request) {
    let body: unknown;
    try { body = JSON.parse(new TextDecoder().decode(request.rawBody)); }
    catch { return Response.json({ error: 'invalid JSON' }, { status: 400 }); }
    if (typeof body !== 'object' || body === null || !('organizationId' in body)) return null;
    return typeof body.organizationId === 'string' && body.organizationId ? body.organizationId : null;
  },
  async verify(request, secrets, triggers) {
    for (const trigger of triggers) {
      const verified = await trigger.verify(request, secrets);
      if (verified) return { accepted: true, events: [trigger.toEvent(verified)] };
    }
    const explainer = triggers.find((trigger) => trigger.explainRejection);
    const rejection = await explainer?.explainRejection?.(request, secrets)
      ?? { reason: 'bad_signature', detail: 'service=linear' };
    return { accepted: false, rejection };
  },
}];
