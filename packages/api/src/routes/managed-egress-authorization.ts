import { createHash, timingSafeEqual } from "node:crypto";
import { Hono } from "hono";
import { validateManagedEgressRequest, type ManagedEgressIdentity } from "@valet/engine";

const MAX_BODY_BYTES = 4096;
const MAX_ID_BYTES = 128;
const MAX_HOST_BYTES = 253;
const MAX_TOKEN_BYTES = 4096;
const REPLAY_TTL_MS = 60_000;
const MAX_REPLAY_ENTRIES = 1024;
const DEFAULT_BODY_READ_TIMEOUT_MS = 2_000;

const SAFE_HEADERS = {
  "Cache-Control": "no-store, no-cache, must-revalidate, private",
  Pragma: "no-cache",
  Expires: "0",
  "Content-Type": "application/json",
} as const;

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

export interface ManagedEgressBindingRegistryOptions {
  maxBindings?: number;
  maxBindingsPerOrg?: number;
}

export interface ManagedEgressAuthorizationRouterOptions {
  bodyReadTimeoutMs?: number;
}

type BodyReadResult = { ok: true; bytes: Uint8Array } | { ok: false; status: 400 | 408 };

function tokenHash(token: string): Buffer {
  return createHash("sha256").update(token).digest();
}

function safe(value: unknown, maximum = MAX_ID_BYTES): value is string {
  return typeof value === "string" && value.length > 0 && Buffer.byteLength(value) <= maximum && /^[\x21-\x7e]+$/.test(value) && !/["\\]/.test(value);
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  return actual.length === keys.length && [...keys].sort().every((key, index) => actual[index] === key);
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function validContentType(value: string | undefined): boolean {
  if (!value) return false;
  const normalized = value.toLowerCase().replaceAll(" ", "");
  return normalized === "application/json" || normalized === "application/json;charset=utf-8";
}

function parseContentLength(value: string | undefined): number | null | false {
  if (value === undefined) return null;
  if (!/^(0|[1-9][0-9]*)$/.test(value)) return false;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed <= MAX_BODY_BYTES ? parsed : false;
}

async function readBoundedBody(request: Request, expectedLength: number | null, timeoutMs: number): Promise<BodyReadResult> {
  const reader = request.body?.getReader();
  if (!reader) return { ok: false, status: 400 };
  const output = new Uint8Array(MAX_BODY_BYTES);
  let offset = 0;
  let timedOut = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      timedOut = true;
      reject(new Error("managed egress request body deadline exceeded"));
    }, timeoutMs);
    timer.unref?.();
  });
  try {
    while (true) {
      const part = await Promise.race([reader.read(), deadline]);
      if (part.done) break;
      if (offset + part.value.byteLength > MAX_BODY_BYTES) {
        void reader.cancel("managed egress request body exceeds 4096 bytes").catch(() => {});
        return { ok: false, status: 400 };
      }
      output.set(part.value, offset);
      offset += part.value.byteLength;
    }
  } catch {
    void reader.cancel("managed egress request body read failed").catch(() => {});
    return { ok: false, status: timedOut ? 408 : 400 };
  } finally {
    if (timer) clearTimeout(timer);
    reader.releaseLock();
  }
  if (expectedLength !== null && expectedLength !== offset) return { ok: false, status: 400 };
  return { ok: true, bytes: output.slice(0, offset) };
}

export function parseAuthorizationRequestV1(value: unknown): AuthorizationRequestV1 | null {
  if (!record(value) || !exactKeys(value, ["version", "request_id", "service", "action", "subject", "destination"])) return null;
  if (value.version !== "1" || value.service !== "egress" || value.action !== "connect" || !safe(value.request_id)) return null;
  if (!record(value.subject) || !exactKeys(value.subject, ["session_id", "workload_id"])) return null;
  if (!safe(value.subject.session_id) || !safe(value.subject.workload_id)) return null;
  if (!record(value.destination) || !exactKeys(value.destination, ["scheme", "protocol", "host", "port"])) return null;
  if (!safe(value.destination.host, MAX_HOST_BYTES) || !Number.isInteger(value.destination.port) || Number(value.destination.port) < 1 || Number(value.destination.port) > 65535) return null;
  const scheme = value.destination.scheme;
  if ((scheme !== "http" && scheme !== "https" && scheme !== "connect") || value.destination.protocol !== "tcp") return null;
  return {
    version: "1", request_id: value.request_id, service: "egress", action: "connect",
    subject: { session_id: value.subject.session_id, workload_id: value.subject.workload_id },
    destination: { scheme, protocol: "tcp", host: value.destination.host, port: Number(value.destination.port) },
  };
}

/** In-memory prerequisite registry. Restart revokes every token and therefore fails closed. */
export class ManagedEgressBindingRegistry {
  private readonly bindings = new Map<string, Binding>();
  private readonly maxBindings: number;
  private readonly maxBindingsPerOrg: number;

  constructor(options: ManagedEgressBindingRegistryOptions = {}) {
    this.maxBindings = options.maxBindings ?? 10_000;
    this.maxBindingsPerOrg = options.maxBindingsPerOrg ?? 1_000;
  }

  get bindingCount(): number {
    return this.bindings.size;
  }

  prune(now = Date.now()): void {
    for (const [proxyId, binding] of this.bindings) {
      if (binding.expiresAt !== undefined && binding.expiresAt <= now) {
        this.bindings.delete(proxyId);
        continue;
      }
      for (const [requestId, replay] of binding.seen) {
        if (replay.at + REPLAY_TTL_MS <= now) binding.seen.delete(requestId);
      }
    }
  }

  private tokenInUse(candidate: Buffer, exceptProxyId?: string): boolean {
    for (const [proxyId, binding] of this.bindings) {
      if (proxyId !== exceptProxyId && timingSafeEqual(candidate, binding.tokenHash)) return true;
    }
    return false;
  }

  register(identity: ManagedEgressIdentity, token: string, expiresAt?: number, now = Date.now()): void {
    validateManagedEgressRequest({ requested: true, identity, proxyToken: token });
    this.prune(now);
    if (this.bindings.has(identity.proxyId)) throw new Error("managed egress proxy binding already exists");
    if (expiresAt !== undefined && (!Number.isFinite(expiresAt) || expiresAt <= now)) throw new Error("managed egress proxy expiry must be in the future");
    if (this.bindings.size >= this.maxBindings) throw new Error("managed egress binding registry capacity exceeded");
    let orgBindings = 0;
    for (const binding of this.bindings.values()) if (binding.identity.orgId === identity.orgId) orgBindings++;
    if (orgBindings >= this.maxBindingsPerOrg) throw new Error("managed egress organization capacity exceeded");
    const candidate = tokenHash(token);
    if (this.tokenInUse(candidate)) throw new Error("managed egress proxy token already has a binding");
    this.bindings.set(identity.proxyId, { identity: { ...identity }, tokenHash: candidate, expiresAt, seen: new Map() });
  }

  rotate(proxyId: string, token: string, now = Date.now()): void {
    this.prune(now);
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
    this.prune(now);
    const candidate = tokenHash(token);
    let binding: Binding | undefined;
    for (const item of this.bindings.values()) if (timingSafeEqual(candidate, item.tokenHash)) binding = item;
    if (!binding) return null;
    if (request.subject.session_id !== binding.identity.sessionId || request.subject.workload_id !== binding.identity.workloadId) return null;
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

export function managedEgressAuthorizationRouter(registry: ManagedEgressBindingRegistry, options: ManagedEgressAuthorizationRouterOptions = {}): Hono {
  const router = new Hono();
  router.all("/v1/authorize", async (c) => {
    if (c.req.method !== "POST") return c.json({ error: "method_not_allowed" }, 405, SAFE_HEADERS);
    if (!validContentType(c.req.header("content-type"))) return c.json({ error: "unsupported_media_type" }, 415, SAFE_HEADERS);
    const authorization = c.req.header("authorization");
    const bearer = authorization?.match(/^Bearer ([^\r\n]+)$/)?.[1];
    if (!bearer || bearer.length < 32 || bearer.length > MAX_TOKEN_BYTES) return c.json({ error: "unauthorized" }, 401, SAFE_HEADERS);
    const contentLength = parseContentLength(c.req.header("content-length"));
    const transferEncoding = c.req.header("transfer-encoding");
    if (contentLength === false || (contentLength !== null && transferEncoding !== undefined) || (transferEncoding !== undefined && transferEncoding.toLowerCase() !== "chunked")) {
      return c.json({ error: "invalid_request" }, 400, SAFE_HEADERS);
    }
    const body = await readBoundedBody(c.req.raw, contentLength, options.bodyReadTimeoutMs ?? DEFAULT_BODY_READ_TIMEOUT_MS);
    if (!body.ok) return c.json({ error: body.status === 408 ? "request_timeout" : "invalid_request" }, body.status, SAFE_HEADERS);
    let parsed: unknown;
    try {
      parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(body.bytes));
    } catch {
      return c.json({ error: "invalid_request" }, 400, SAFE_HEADERS);
    }
    const request = parseAuthorizationRequestV1(parsed);
    if (!request) return c.json({ error: "invalid_request" }, 400, SAFE_HEADERS);
    const response = registry.authorize(bearer, request);
    if (!response) return c.json({ error: "unauthorized" }, 401, SAFE_HEADERS);
    return c.json(response, 200, SAFE_HEADERS);
  });
  return router;
}
