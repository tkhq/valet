import type { Hono, Handler } from 'hono';
import { validatePluginHttpRoutes, type PluginHttpCaller, type PluginHttpRequest, type PluginHttpRoute, type ValetPlugin } from '@valet/engine';
import type { AppEnv } from '../env.js';
import { requireActingUser } from '../middleware/auth.js';
import { requireOrgAdmin } from '../routes/_org-admin.js';
import { isOrgMember } from '../services/org.js';
import { ingestEvent } from '../events/ingest.js';
import { writeDropLog } from '../orchestrator/signals.js';
import { httpInstallationResolvers } from './http-installations.js';
import { httpBindingMismatch, httpRouteBinding, httpRouteBindings } from './http-bindings.js';

interface LegacyRoute {
  path: string;
  method: PluginHttpRoute['method'];
  auth: PluginHttpRoute['auth'];
}

/**
 * Only the host can reserve existing URLs. Plugins declare relative paths.
 * Each alias fixes its method and authentication, so a plugin cannot widen
 * access to an existing URL by changing its declaration.
 */
const LEGACY_ROUTES: Readonly<Record<string, Readonly<Record<string, LegacyRoute>>>> = {
  linear: {
    events: { path: '/webhooks/events/linear', method: 'POST', auth: 'signature' },
    // The web client's Linear settings read and write the organization connection here.
    'connection-status': { path: '/api/org/linear', method: 'GET', auth: 'org-admin' },
    'connection-save': { path: '/api/org/linear', method: 'PUT', auth: 'org-admin' },
    'connection-delete': { path: '/api/org/linear', method: 'DELETE', auth: 'org-admin' },
  },
  github: {
    // Existing GitHub Apps store the setup, callback, and webhook URLs.
    'app-status': { path: '/api/org/github-app', method: 'GET', auth: 'org-admin' },
    'app-manifest': { path: '/api/org/github-app/manifest', method: 'POST', auth: 'org-admin' },
    'app-setup': { path: '/api/org/github-app/setup', method: 'GET', auth: 'user' },
    'app-credential': { path: '/api/org/github-app/credential', method: 'POST', auth: 'org-admin' },
    'app-refresh': { path: '/api/org/github-app/refresh', method: 'POST', auth: 'org-admin' },
    'app-disconnect': { path: '/api/org/github-app', method: 'DELETE', auth: 'org-admin' },
    connect: { path: '/api/me/github/connect', method: 'POST', auth: 'user' },
    'org-status': { path: '/api/me/github/org-status', method: 'GET', auth: 'user' },
    callback: { path: '/api/me/github/callback', method: 'GET', auth: 'user' },
    disconnect: { path: '/api/me/github', method: 'DELETE', auth: 'user' },
    webhook: { path: '/webhooks/github-app', method: 'POST', auth: 'public' },
  },
  slack: {
    // Installed Slack apps call this URL for Events API and interactivity deliveries.
    events: { path: '/api/channels/slack/webhook', method: 'POST', auth: 'public' },
    // The web client reads the setup view here.
    app: { path: '/api/org/slack', method: 'GET', auth: 'org-admin' },
  },
};

/**
 * Names the route IDs that a host binding or compatibility URL serves but the
 * plugin does not declare. Mounting skips such an entry, so a renamed route
 * would otherwise answer 404 at a URL that existing Apps and installs still
 * call. A plugin that declares no HTTP routes mounts nothing and is not
 * checked: test fixtures reuse bundled plugin names without routes.
 */
export function undeclaredHostRoutes(plugin: ValetPlugin): string | undefined {
  if (!plugin.httpRoutes?.length) return undefined;
  const declared = new Set(plugin.httpRoutes.map((route) => route.id));
  const bindings = Object.hasOwn(httpRouteBindings, plugin.name) ? Object.keys(httpRouteBindings[plugin.name]) : [];
  const aliases = Object.hasOwn(LEGACY_ROUTES, plugin.name) ? Object.keys(LEGACY_ROUTES[plugin.name]) : [];
  const missing = [...new Set([...bindings, ...aliases])].filter((id) => !declared.has(id));
  if (!missing.length) return undefined;
  return `Plugin ${plugin.name} declares no HTTP route for host route ID(s) ${missing.join(', ')}. ` +
    'Restore the route IDs, or update the host bindings and compatibility routes to match.';
}

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
      const mismatch = httpBindingMismatch(plugin.name, route);
      if (mismatch) throw new Error(mismatch);
      const binding = httpRouteBinding(plugin.name, route.id);
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
        const headers = new Headers(c.req.raw.headers);
        // Host authentication is represented by caller, never reusable credentials.
        for (const name of ['cookie', 'authorization', 'x-api-key', 'x-valet-sandbox', 'x-valet-test-user-id', 'x-valet-internal']) headers.delete(name);
        const request: PluginHttpRequest = {
          url: c.req.url, headers: Object.fromEntries(headers),
          params: c.req.param(), rawBody, signal: c.req.raw.signal,
        };
        const { providers } = c.var;
        if (route.auth === 'public') return binding ? binding.bind({ providers, request }) : route.handle(request);
        if (route.auth !== 'signature') {
          if (!caller) return c.json({ error: 'Sign in to use this plugin route.' }, 401);
          return binding ? binding.bind({ providers, request, caller }) : route.handle(request, caller);
        }
        const key = route.installationKey(request);
        if (key !== null && typeof key !== 'string') return key;
        const ack = () => new Response(null, { status: route.acknowledgementStatus });
        if (key === null) return ack();
        if (!resolveInstallation) throw new Error('Plugin installation resolver is unavailable. Restart the API.');
        const { db, eventDispatcher } = c.var.providers;
        const installation = await resolveInstallation(db, key);
        if (!installation) return ack();
        const triggers = c.var.providers.plugins.flatMap((loaded) => loaded.triggers ?? []).filter((trigger) => trigger.service === plugin.name);
        const verification = await route.verify(request, installation.secrets, triggers);
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
      const aliases = Object.hasOwn(LEGACY_ROUTES, plugin.name) ? LEGACY_ROUTES[plugin.name] : undefined;
      const legacy = aliases && Object.hasOwn(aliases, route.id) ? aliases[route.id] : undefined;
      if (legacy) {
        if (route.auth !== legacy.auth || route.method !== legacy.method) {
          throw new Error(`Compatibility route ${legacy.method} ${legacy.path} requires ${legacy.auth} authentication.`);
        }
        app.on(route.method, legacy.path, handler);
      }
    }
    const undeclared = undeclaredHostRoutes(plugin);
    if (undeclared) throw new Error(undeclared);
  }
}
