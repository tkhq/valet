import { createHash, timingSafeEqual } from "node:crypto";
import { Hono } from "hono";
import { validateManagedEgressRequest, type ManagedEgressIdentity } from "@valet/engine";

const MAX_BODY_BYTES = 4096;
const MAX_SAFE = 128;
const REPLAY_TTL_MS = 60_000;
const MAX_REPLAY_ENTRIES = 1024;

interface Binding {
  identity: ManagedEgressIdentity;
  tokenHash: Buffer;
  expiresAt?: number;
  seen: Map<string, { at: number; response: AuthorizationResponse }>;
}

export interface AuthorizationRequestV1 {
  version: "1";
  request_id: string;
  service: "egress";
  action: "connect";
  subject: { session_id: string; workload_id: string };
  destination: { scheme: "http" | "https" | "connect"; protocol: "tcp"; host: string; port: number };
}

interface AuthorizationResponse {
  version: "1";
  request_id: string;
  decision: "deny";
  decision_id: string;
  reason_code: "unsupported_prerequisite";
}

function tokenHash(token: string): Buffer {
  return createHash("sha256").update(token).digest();
}

function safe(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= MAX_SAFE && /^[\x21-\x7e]+$/.test(value) && !/["\\]/.test(value);
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  return actual.length === keys.length && [...keys].sort().every((key, index) => actual[index] === key);
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function parseAuthorizationRequestV1(value: unknown): AuthorizationRequestV1 | null {
  if (!record(value) || !exactKeys(value, ["version", "request_id", "service", "action", "subject", "destination"])) return null;
  if (value.version !== "1" || value.service !== "egress" || value.action !== "connect" || !safe(value.request_id)) return null;
  if (!record(value.subject) || !exactKeys(value.subject, ["session_id", "workload_id"])) return null;
  if (!safe(value.subject.session_id) || !safe(value.subject.workload_id)) return null;
  if (!record(value.destination) || !exactKeys(value.destination, ["scheme", "protocol", "host", "port"])) return null;
  if (!(["http", "https", "connect"] as unknown[]).includes(value.destination.scheme) || value.destination.protocol !== "tcp") return null;
  if (!safe(value.destination.host) || !Number.isInteger(value.destination.port) || Number(value.destination.port) < 1 || Number(value.destination.port) > 65535) return null;
  const scheme = value.destination.scheme;
  if (scheme !== "http" && scheme !== "https" && scheme !== "connect") return null;
  return {
    version: "1", request_id: value.request_id, service: "egress", action: "connect",
    subject: { session_id: value.subject.session_id, workload_id: value.subject.workload_id },
    destination: { scheme, protocol: "tcp", host: value.destination.host, port: Number(value.destination.port) },
  };
}

/** In-memory prerequisite registry. Restart revokes every token and therefore fails closed. */
export class ManagedEgressBindingRegistry {
  private readonly bindings = new Map<string, Binding>();

  private tokenInUse(candidate: Buffer, exceptProxyId?: string): boolean {
    for (const [proxyId, binding] of this.bindings) {
      if (proxyId !== exceptProxyId && timingSafeEqual(candidate, binding.tokenHash)) return true;
    }
    return false;
  }

  register(identity: ManagedEgressIdentity, token: string, expiresAt?: number): void {
    validateManagedEgressRequest({ requested: true, identity, proxyToken: token });
    if (this.bindings.has(identity.proxyId)) throw new Error("managed egress proxy binding already exists");
    if (expiresAt !== undefined && !Number.isFinite(expiresAt)) throw new Error("managed egress proxy expiry is invalid");
    const candidate = tokenHash(token);
    if (this.tokenInUse(candidate)) throw new Error("managed egress proxy token already has a binding");
    this.bindings.set(identity.proxyId, { identity: { ...identity }, tokenHash: candidate, expiresAt, seen: new Map() });
  }

  rotate(proxyId: string, token: string): void {
    const binding = this.bindings.get(proxyId);
    if (!binding) throw new Error("managed egress proxy binding not found");
    validateManagedEgressRequest({ requested: true, identity: binding.identity, proxyToken: token });
    const candidate = tokenHash(token);
    if (this.tokenInUse(candidate, proxyId)) throw new Error("managed egress proxy token already has a binding");
    binding.tokenHash = candidate;
    binding.seen.clear();
  }

  revoke(proxyId: string): void {
    this.bindings.delete(proxyId);
  }

  authorize(token: string, request: AuthorizationRequestV1, now = Date.now()): AuthorizationResponse | null {
    const candidate = tokenHash(token);
    let binding: Binding | undefined;
    for (const item of this.bindings.values()) {
      if (timingSafeEqual(candidate, item.tokenHash)) binding = item;
    }
    if (!binding || (binding.expiresAt !== undefined && binding.expiresAt <= now)) return null;
    if (request.subject.session_id !== binding.identity.sessionId || request.subject.workload_id !== binding.identity.workloadId) return null;
    for (const [id, replay] of binding.seen) if (replay.at + REPLAY_TTL_MS <= now) binding.seen.delete(id);
    const replay = binding.seen.get(request.request_id);
    if (replay) return replay.response;
    const correlation = createHash("sha256").update(JSON.stringify(binding.identity)).digest("hex").slice(0, 16);
    const response: AuthorizationResponse = {
      version: "1",
      request_id: request.request_id,
      decision: "deny",
      decision_id: `unsupported-${correlation}-${createHash("sha256").update(request.request_id).digest("hex").slice(0, 12)}`,
      reason_code: "unsupported_prerequisite",
    };
    if (binding.seen.size >= MAX_REPLAY_ENTRIES) {
      const oldest = binding.seen.keys().next().value;
      if (oldest !== undefined) binding.seen.delete(oldest);
    }
    binding.seen.set(request.request_id, { at: now, response });
    return response;
  }
}

export function managedEgressAuthorizationRouter(registry: ManagedEgressBindingRegistry): Hono {
  const router = new Hono();
  router.post("/v1/authorize", async (c) => {
    const headers = {
      "Cache-Control": "no-store, no-cache, must-revalidate, private",
      Pragma: "no-cache",
      Expires: "0",
      "Content-Type": "application/json",
    };
    const authorization = c.req.header("authorization");
    if (!authorization?.startsWith("Bearer ") || authorization.length > MAX_BODY_BYTES) return c.json({ error: "unauthorized" }, 401, headers);
    const length = Number(c.req.header("content-length") ?? "0");
    if (!Number.isFinite(length) || length > MAX_BODY_BYTES) return c.json({ error: "invalid_request" }, 400, headers);
    const text = await c.req.text();
    if (Buffer.byteLength(text) > MAX_BODY_BYTES) return c.json({ error: "invalid_request" }, 400, headers);
    let body: unknown;
    try { body = JSON.parse(text); } catch { return c.json({ error: "invalid_request" }, 400, headers); }
    const request = parseAuthorizationRequestV1(body);
    if (!request) return c.json({ error: "invalid_request" }, 400, headers);
    const response = registry.authorize(authorization.slice(7), request);
    if (!response) return c.json({ error: "unauthorized" }, 401, headers);
    return c.json(response, 200, headers);
  });
  return router;
}
