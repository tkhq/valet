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
 */
export interface PluginHttpBinding {
  /** Must equal the route's declared authentication. Mounting fails otherwise. */
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
