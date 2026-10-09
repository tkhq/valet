import type { PluginHttpRequest } from "@valet/engine";

export function json(body: unknown, status = 200): Response {
  return Response.json(body, { status });
}

export function noContent(): Response {
  return new Response(null, { status: 204 });
}

/** Keeps relative locations, which `Response.redirect` rejects. */
export function redirect(location: string): Response {
  return new Response(null, { status: 302, headers: { location } });
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/** Parses the raw body as JSON. Undefined when the body is empty or not JSON. */
export function readJson(request: PluginHttpRequest): unknown {
  try {
    return JSON.parse(new TextDecoder().decode(request.rawBody));
  } catch {
    return undefined;
  }
}

export function queryParam(request: PluginHttpRequest, name: string): string | undefined {
  return new URL(request.url).searchParams.get(name) ?? undefined;
}
