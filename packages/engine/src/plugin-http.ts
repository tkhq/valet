import type { NormalizedEvent, PluginValidationIssue, TriggerRejection } from './valet-plugin.js';

/** Portable declarations only. The API host owns routing and authentication. */
export interface PluginHttpRequest {
  url: string;
  headers: Record<string, string>;
  params: Record<string, string>;
  rawBody: Uint8Array;
  signal: AbortSignal;
}

export interface PluginHttpCaller {
  userId: string;
  orgId: string;
}

interface RouteBase {
  id: string;
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  /** Relative to the host-assigned plugin namespace. No wildcards. */
  path: string;
  maxBodyBytes: number;
}

export type PluginIngressVerification =
  | { accepted: true; events: NormalizedEvent[] }
  | { accepted: false; rejection: TriggerRejection };

export type PluginHttpRoute =
  | (RouteBase & {
      auth: 'public';
      handle(request: PluginHttpRequest): Response | Promise<Response>;
    })
  | (RouteBase & {
      auth: 'user' | 'org-admin';
      handle(request: PluginHttpRequest, caller: PluginHttpCaller): Response | Promise<Response>;
    })
  | (RouteBase & {
      auth: 'signature';
      method: 'POST';
      /** Untrusted lookup key. The host selects the installation and signing metadata. */
      installationKey(request: PluginHttpRequest): string | null | Response;
      verify(request: PluginHttpRequest, secrets: Record<string, string>): PluginIngressVerification | Promise<PluginIngressVerification>;
      /** Also used for unknown installations and signed, unsupported events. */
      acknowledgementStatus: 200 | 202 | 204;
    });

export const MAX_PLUGIN_HTTP_BODY_BYTES = 1024 * 1024;
const METHODS = new Set(['GET', 'POST', 'PUT', 'PATCH', 'DELETE']);
const SEGMENT = /^(?:[a-zA-Z0-9_-]+|:[a-zA-Z][a-zA-Z0-9_]*)$/;

export function validatePluginHttpRoutes(value: unknown): PluginValidationIssue[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) return [{ path: 'httpRoutes', message: 'must be an array' }];
  const issues: PluginValidationIssue[] = [];
  const ids = new Set<string>();
  const paths: Array<{ method: string; segments: string[] }> = [];
  const routes: unknown[] = value;
  for (const [index, route] of routes.entries()) {
    const path = `httpRoutes[${index}]`;
    const fail = (field: string, message: string) => issues.push({ path: `${path}.${field}`, message });
    if (!isRecord(route)) {
      fail('', 'must be an object');
      continue;
    }
    if (typeof route.id !== 'string' || !/^[a-z][a-z0-9-]*$/.test(route.id) || ids.has(route.id)) {
      fail('id', 'use a unique lowercase route ID');
    } else ids.add(route.id);
    if (typeof route.method !== 'string' || !METHODS.has(route.method)) fail('method', 'use GET, POST, PUT, PATCH, or DELETE');
    const segments = typeof route.path === 'string' ? route.path.slice(1).split('/') : [];
    const params = segments.filter((segment: string) => segment.startsWith(':'));
    if (typeof route.path !== 'string' || !route.path.startsWith('/') || !segments.length ||
        !segments.every((segment: string) => SEGMENT.test(segment)) || new Set(params).size !== params.length) {
      fail('path', 'use slash-separated literal or named parameter segments');
    } else {
      if (paths.some((other) => other.method === route.method && other.segments.length === segments.length &&
          other.segments.every((segment, i) => segment === segments[i] || segment.startsWith(':') || segments[i].startsWith(':')))) {
        fail('path', 'route overlaps another route for this method');
      }
      if (typeof route.method === 'string') paths.push({ method: route.method, segments });
    }
    if (typeof route.maxBodyBytes !== 'number' || !Number.isSafeInteger(route.maxBodyBytes) || route.maxBodyBytes < 0 || route.maxBodyBytes > MAX_PLUGIN_HTTP_BODY_BYTES) {
      fail('maxBodyBytes', `use an integer between 0 and ${MAX_PLUGIN_HTTP_BODY_BYTES}`);
    }
    if (route.auth === 'signature') {
      if (route.method !== 'POST') fail('method', 'signature ingress requires POST');
      if (typeof route.installationKey !== 'function') fail('installationKey', 'required function');
      if (typeof route.verify !== 'function') fail('verify', 'required function');
      if (typeof route.acknowledgementStatus !== 'number' || ![200, 202, 204].includes(route.acknowledgementStatus)) fail('acknowledgementStatus', 'use 200, 202, or 204');
      if (route.handle !== undefined) fail('handle', 'signature ingress uses verify, not a handler');
    } else if (typeof route.auth === 'string' && ['public', 'user', 'org-admin'].includes(route.auth)) {
      if (typeof route.handle !== 'function') fail('handle', 'required function');
      if (route.verify !== undefined || route.installationKey !== undefined) fail('auth', 'verification requires signature authentication');
    } else fail('auth', 'use public, user, org-admin, or signature');
  }
  return issues;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
