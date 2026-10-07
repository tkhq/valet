import type { Hono, Handler } from 'hono';
import { validatePluginHttpRoutes, type PluginHttpCaller, type PluginHttpRequest, type ValetPlugin } from '@valet/engine';
import type { AppEnv } from '../env.js';
import { requireActingUser } from '../middleware/auth.js';
import { requireOrgAdmin } from '../routes/_org-admin.js';
import { isOrgMember } from '../services/org.js';
import { ingestEvent } from '../events/ingest.js';
import { writeDropLog } from '../orchestrator/signals.js';
import { httpInstallationResolvers } from './http-installations.js';

/** Only the host can reserve existing public URLs. Plugins declare relative paths. */
const LEGACY_PATHS: Readonly<Record<string, Readonly<Record<string, string>>>> = {
  linear: { events: '/webhooks/events/linear' },
};

const tooLarge = () => Response.json({ error: 'payload too large' }, { status: 413 });

/** Stop buffering as soon as the limit is exceeded, even without Content-Length. */
export async function readPluginBody(request: Request, limit: number): Promise<Uint8Array | null> {
  const declaredLength = request.headers.get('content-length');
  if (declaredLength !== null && Number(declaredLength) > limit) {
    await request.body?.cancel();
    return null;
  }
  if (!request.body) return new Uint8Array();
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > limit) {
        await reader.cancel();
        return null;
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  return bytes;
}

/** Call once before authentication for public routes, then once after it for user routes. */
export function mountPluginHttpRoutes(app: Hono<AppEnv>, plugins: ValetPlugin[], phase: 'public' | 'authenticated'): void {
  for (const plugin of plugins) {
    if (!plugin.httpRoutes?.length) continue;
    if (!/^[a-z][a-z0-9-]*$/.test(plugin.name)) throw new Error('Use a valid plugin name before registering HTTP routes.');
    const issues = validatePluginHttpRoutes(plugin.httpRoutes);
    if (issues.length) throw new Error(`Invalid HTTP routes for ${plugin.name}: ${issues.map((issue) => issue.message).join('; ')}`);
    for (const route of plugin.httpRoutes) {
      const publicRoute = route.auth === 'public' || route.auth === 'signature';
      if (publicRoute !== (phase === 'public')) continue;
      const resolveInstallation = Object.hasOwn(httpInstallationResolvers, plugin.name) ? httpInstallationResolvers[plugin.name] : undefined;
      if (route.auth === 'signature' && !resolveInstallation) {
        throw new Error(`Configure an installation resolver for plugin ${plugin.name} before mounting signed ingress.`);
      }
      const handler: Handler<AppEnv> = async (c) => {
        let caller: PluginHttpCaller | undefined;
        if (!publicRoute) {
          const user = requireActingUser(c);
          if (!user) return c.json({ error: 'Sign in to use this plugin route.' }, 401);
          if (!(await isOrgMember(c.var.providers.db, user.orgId, user.id))) {
            return c.json({ error: 'Organization membership required. Ask an administrator for access.' }, 403);
          }
          if (route.auth === 'org-admin') {
            const denied = await requireOrgAdmin(c);
            if (denied) return denied;
          }
          caller = { userId: user.id, orgId: user.orgId };
        }
        const rawBody = await readPluginBody(c.req.raw, route.maxBodyBytes);
        if (rawBody === null) return tooLarge();
        const request: PluginHttpRequest = {
          url: c.req.url, headers: Object.fromEntries(c.req.raw.headers),
          params: c.req.param(), rawBody, signal: c.req.raw.signal,
        };
        if (route.auth === 'public') return route.handle(request);
        if (route.auth !== 'signature') {
          if (!caller) return c.json({ error: 'Sign in to use this plugin route.' }, 401);
          return route.handle(request, caller);
        }
        const key = route.installationKey(request);
        if (key !== null && typeof key !== 'string') return key;
        const ack = () => new Response(null, { status: route.acknowledgementStatus });
        if (key === null) return ack();
        if (!resolveInstallation) throw new Error('Plugin installation resolver is unavailable. Restart the API.');
        const { db, eventDispatcher } = c.var.providers;
        const installation = await resolveInstallation(db, key);
        if (!installation) return ack();
        const verification = await route.verify(request, installation.secrets);
        if (!verification.accepted) {
          await writeDropLog(db, {
            orgId: installation.orgId, reason: verification.rejection.reason, detail: verification.rejection.detail,
          });
          if (verification.rejection.reason !== 'bad_signature') return ack();
          return c.json({ error: 'signature verification failed' }, 403);
        }
        for (const event of verification.events) {
          await ingestEvent({ db, plugins: c.var.providers.plugins, onIngest: eventDispatcher.nudge }, {
            orgId: installation.orgId, service: plugin.name, event,
          });
        }
        return ack();
      };
      const prefix = publicRoute ? '/plugins' : '/api/plugins';
      app.on(route.method, `${prefix}/${plugin.name}/http${route.path}`, handler);
      const aliases = Object.hasOwn(LEGACY_PATHS, plugin.name) ? LEGACY_PATHS[plugin.name] : undefined;
      const legacy = aliases && Object.hasOwn(aliases, route.id) ? aliases[route.id] : undefined;
      if (legacy) {
        if (route.auth !== 'signature') throw new Error(`Legacy ingress ${legacy} requires signature authentication.`);
        app.on(route.method, legacy, handler);
      }
    }
  }
}
