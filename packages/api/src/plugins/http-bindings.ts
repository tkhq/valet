import type { PluginHttpCaller, PluginHttpRequest, PluginHttpRoute } from '@valet/engine';
import type { Providers } from '../providers/types.js';
import { githubHttpBindings } from './http-github.js';
import { slackHttpBindings } from './http-slack.js';

export interface PluginHttpBindingContext {
  providers: Providers;
  request: PluginHttpRequest;
  /** Present only for authenticated routes. The host derived it from the session. */
  caller?: PluginHttpCaller;
}

/**
 * Binds one bundled route to request-scoped host capabilities. The host
 * runs the binding after authentication, membership, administration, and
 * body-limit checks. The binding replaces the manifest handler.
 *
 * The method, path, and authentication pin the declaration that the binding
 * serves. A plugin with the same name cannot move a bound route ID to another
 * URL or widen its access: the mount refuses the mismatch, and the
 * node_modules loader quarantines the package.
 */
export interface PluginHttpBinding {
  method: PluginHttpRoute['method'];
  path: string;
  auth: PluginHttpRoute['auth'];
  bind(context: PluginHttpBindingContext): Promise<Response>;
}

/** Host-owned bindings by plugin name, then route ID. Only bundled plugins appear here. */
export const httpRouteBindings: Readonly<Record<string, Readonly<Record<string, PluginHttpBinding>>>> = {
  github: githubHttpBindings,
  slack: slackHttpBindings,
};

export function httpRouteBinding(pluginName: string, routeId: string): PluginHttpBinding | undefined {
  const routes = Object.hasOwn(httpRouteBindings, pluginName) ? httpRouteBindings[pluginName] : undefined;
  return routes && Object.hasOwn(routes, routeId) ? routes[routeId] : undefined;
}

/** Names the required declaration when a route ID that the host binds has another shape. */
export function httpBindingMismatch(pluginName: string, route: PluginHttpRoute): string | undefined {
  const binding = httpRouteBinding(pluginName, route.id);
  if (!binding || (binding.method === route.method && binding.path === route.path && binding.auth === route.auth)) return undefined;
  return `Declare ${pluginName} route ${route.id} as ${binding.method} ${binding.path} with ${binding.auth} authentication.`;
}
