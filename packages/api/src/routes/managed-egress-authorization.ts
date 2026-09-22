import { createHash, timingSafeEqual } from "node:crypto";
import { Hono } from "hono";
import { isHematiteRequestId, validateManagedEgressRequest, type ManagedEgressEffectiveState, type ManagedEgressIdentity } from "@valet/engine";
import { adaptEgressConnect, canonicalAuthorizationJson, type AuthorizationPrincipal } from "@valet/engine/authorization";
import { canonicalDecisionId, type CanonicalAuthorizationService } from "../authorization/canonical-authorization-service.js";

export const MANAGED_EGRESS_MAX_BODY_BYTES = 4096;
const MAX_ID_BYTES = 128;
const MAX_HOST_BYTES = 253;
const MAX_TOKEN_BYTES = 4096;
const REPLAY_TTL_MS = 60_000;
const MAX_REPLAY_ENTRIES = 1024;
const DEFAULT_BODY_READ_TIMEOUT_MS = 2_000;
const DEFAULT_EVALUATION_WINDOW_MS = 1_000;
const DEFAULT_MAX_EVALUATIONS_PER_WINDOW = 120;

const SAFE_HEADERS = {
  "Cache-Control": "no-store, no-cache, must-revalidate, private",
  Pragma: "no-cache",
  Expires: "0",
  "Content-Type": "application/json",
} as const;

export interface ManagedEgressPolicyIdentity {
  actorUserId: string;
  principal: AuthorizationPrincipal;
}

export interface ManagedEgressBindingActivation {
  effective: ManagedEgressEffectiveState;
  policyIdentity: ManagedEgressPolicyIdentity;
}

interface Binding {
  identity: ManagedEgressIdentity;
  tokenHash: Buffer;
  expiresAt?: number;
  activation?: ManagedEgressBindingActivation;
  seen: Map<string, { at: number; requestDigest: string; response: AuthorizationResponse }>;
  pending: Map<string, { requestDigest: string; response: Promise<AuthorizationResponse> }>;
  evaluationWindowStartedAt: number;
  evaluationCount: number;
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
  decision: "allow" | "deny";
  decision_id: string;
  reason_code: "policy_allow" | "policy_denied" | "unsupported_prerequisite" | "authorization_failure" | "rate_limited";
}

export interface ManagedEgressBindingRegistryOptions {
  maxBindings?: number;
  maxBindingsPerOrg?: number;
  authorization?: Pick<CanonicalAuthorizationService, "authorize">;
  evaluationWindowMs?: number;
  maxEvaluationsPerWindow?: number;
  now?: () => number;
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
  return Number.isSafeInteger(parsed) && parsed <= MANAGED_EGRESS_MAX_BODY_BYTES ? parsed : false;
}

async function readBoundedBody(request: Request, expectedLength: number | null, timeoutMs: number): Promise<BodyReadResult> {
  const reader = request.body?.getReader();
  if (!reader) return { ok: false, status: 400 };
  const output = new Uint8Array(MANAGED_EGRESS_MAX_BODY_BYTES);
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
      if (offset + part.value.byteLength > MANAGED_EGRESS_MAX_BODY_BYTES) {
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
  if (value.version !== "1" || value.service !== "egress" || value.action !== "connect" || !isHematiteRequestId(value.request_id)) return null;
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

function assertActivation(identity: ManagedEgressIdentity, activation: ManagedEgressBindingActivation): void {
  const effective = activation.effective;
  if (!effective.requested || !effective.configured || !effective.ready || !effective.effective || canonicalAuthorizationJson(effective.identity) !== canonicalAuthorizationJson(identity)) {
    throw new Error("managed egress callback activation requires the observed effective boundary identity");
  }
  if (effective.topology.callbackBindingId.length === 0 || effective.topology.proxyResources.length === 0 || effective.topology.policyResources.length === 0 || Object.keys(effective.topology.workloadSelector).length === 0) {
    throw new Error("managed egress callback activation requires complete topology identity");
  }
  if (activation.policyIdentity.actorUserId.length === 0 || activation.policyIdentity.principal.id.length === 0) {
    throw new Error("managed egress callback activation requires server-bound policy identity");
  }
}

/** In-memory prerequisite registry. Restart revokes every token and therefore fails closed. */
export class ManagedEgressBindingRegistry {
  private readonly bindings = new Map<string, Binding>();
  private readonly maxBindings: number;
  private readonly maxBindingsPerOrg: number;
  private readonly authorization?: Pick<CanonicalAuthorizationService, "authorize">;
  private readonly evaluationWindowMs: number;
  private readonly maxEvaluationsPerWindow: number;
  private readonly now: () => number;

  constructor(options: ManagedEgressBindingRegistryOptions = {}) {
    this.maxBindings = options.maxBindings ?? 4_096;
    this.maxBindingsPerOrg = options.maxBindingsPerOrg ?? 512;
    this.authorization = options.authorization;
    this.evaluationWindowMs = options.evaluationWindowMs ?? DEFAULT_EVALUATION_WINDOW_MS;
    this.maxEvaluationsPerWindow = options.maxEvaluationsPerWindow ?? DEFAULT_MAX_EVALUATIONS_PER_WINDOW;
    if (!Number.isSafeInteger(this.evaluationWindowMs) || this.evaluationWindowMs < 1 || !Number.isSafeInteger(this.maxEvaluationsPerWindow) || this.maxEvaluationsPerWindow < 1) throw new TypeError("Set positive managed egress rate limits.");
    this.now = options.now ?? Date.now;
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

  register(identity: ManagedEgressIdentity, token: string, expiresAt?: number, now = Date.now(), activation?: ManagedEgressBindingActivation): void {
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
    if (activation) assertActivation(identity, activation);
    this.bindings.set(identity.proxyId, {
      identity: { ...identity },
      tokenHash: candidate,
      expiresAt,
      ...(activation ? { activation } : {}),
      seen: new Map(),
      pending: new Map(),
      evaluationWindowStartedAt: now,
      evaluationCount: 0,
    });
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
    binding.pending.clear();
    binding.evaluationWindowStartedAt = now;
    binding.evaluationCount = 0;
  }

  revoke(proxyId: string): void {
    this.bindings.delete(proxyId);
  }

  async authorize(token: string, request: AuthorizationRequestV1, now = this.now()): Promise<AuthorizationResponse | null> {
    this.prune(now);
    const candidate = tokenHash(token);
    let binding: Binding | undefined;
    for (const item of this.bindings.values()) if (timingSafeEqual(candidate, item.tokenHash)) binding = item;
    if (!binding) return null;
    if (request.subject.session_id !== binding.identity.sessionId || request.subject.workload_id !== binding.identity.workloadId) return null;
    const requestDigest = createHash("sha256").update(canonicalAuthorizationJson(request)).digest("hex");
    const replay = binding.seen.get(request.request_id);
    if (replay) return replay.requestDigest === requestDigest ? replay.response : null;
    const pending = binding.pending.get(request.request_id);
    if (pending) return pending.requestDigest === requestDigest ? pending.response : null;
    if (now - binding.evaluationWindowStartedAt >= this.evaluationWindowMs) {
      binding.evaluationWindowStartedAt = now;
      binding.evaluationCount = 0;
    }
    if (binding.evaluationCount >= this.maxEvaluationsPerWindow) {
      const throttled: AuthorizationResponse = {
        version: "1",
        request_id: request.request_id,
        decision: "deny",
        decision_id: `throttled-${createHash("sha256").update(`${binding.identity.proxyId}\0${request.request_id}`).digest("hex").slice(0, 28)}`,
        reason_code: "rate_limited",
      };
      if (binding.seen.size >= MAX_REPLAY_ENTRIES) {
        const oldest = binding.seen.keys().next().value;
        if (oldest !== undefined) binding.seen.delete(oldest);
      }
      binding.seen.set(request.request_id, { at: now, requestDigest, response: throttled });
      return throttled;
    }
    binding.evaluationCount++;
    const response = this.evaluate(binding, request, now).then((result) => {
      if (binding.seen.size >= MAX_REPLAY_ENTRIES) {
        const oldest = binding.seen.keys().next().value;
        if (oldest !== undefined) binding.seen.delete(oldest);
      }
      binding.seen.set(request.request_id, { at: now, requestDigest, response: result });
      return result;
    }).finally(() => binding.pending.delete(request.request_id));
    binding.pending.set(request.request_id, { requestDigest, response });
    return response;
  }

  private async evaluate(binding: Binding, request: AuthorizationRequestV1, now: number): Promise<AuthorizationResponse> {
    const unsupported = (reason_code: AuthorizationResponse["reason_code"] = "unsupported_prerequisite"): AuthorizationResponse => ({
      version: "1",
      request_id: request.request_id,
      decision: "deny",
      decision_id: `unsupported-${createHash("sha256").update(`${binding.identity.proxyId}\0${request.request_id}`).digest("hex").slice(0, 28)}`,
      reason_code,
    });
    if (!binding.activation || !this.authorization) return unsupported();
    try {
      assertActivation(binding.identity, binding.activation);
      const operationId = `egress:${createHash("sha256").update(`${binding.identity.proxyId}\0${request.request_id}`).digest("hex").slice(0, 32)}`;
      const adapted = adaptEgressConnect({
        schemaVersion: 1,
        organizationId: binding.identity.orgId,
        actorUserId: binding.activation.policyIdentity.actorUserId,
        principal: binding.activation.policyIdentity.principal,
        requestId: request.request_id,
        operationId,
        evaluationTimeMs: now,
        sessionId: binding.identity.sessionId,
        operation: "connect",
        destination: {
          scheme: request.destination.scheme,
          protocol: request.destination.protocol,
          host: request.destination.host,
          port: request.destination.port,
          destinationClass: "external",
        },
      });
      const envelope = await this.authorization.authorize(adapted.request);
      const effect = envelope.decision.effect;
      return {
        version: "1",
        request_id: request.request_id,
        decision: effect === "allow" ? "allow" : "deny",
        decision_id: canonicalDecisionId(binding.identity.orgId, adapted.request.idempotencyKey),
        reason_code: effect === "allow" ? "policy_allow" : effect === "require_approval" ? "unsupported_prerequisite" : "policy_denied",
      };
    } catch {
      return unsupported("authorization_failure");
    }
  }
}

export function managedEgressAuthorizationRouter(registry: ManagedEgressBindingRegistry, options: ManagedEgressAuthorizationRouterOptions = {}): Hono {
  const router = new Hono();
  router.all("/v1/authorize", async (c) => {
    if (c.req.method !== "POST") return c.json({ error: "method_not_allowed" }, 405, SAFE_HEADERS);
    if (!validContentType(c.req.header("content-type"))) return c.json({ error: "unsupported_media_type" }, 415, SAFE_HEADERS);
    const authorization = c.req.header("authorization");
    const bearer = authorization?.match(/^Bearer ([^\r\n]+)$/)?.[1];
    const bearerBytes = bearer === undefined ? 0 : Buffer.byteLength(bearer, "utf8");
    if (!bearer || bearerBytes < 32 || bearerBytes > MAX_TOKEN_BYTES) return c.json({ error: "unauthorized" }, 401, SAFE_HEADERS);
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
    const response = await registry.authorize(bearer, request);
    if (!response) return c.json({ error: "unauthorized" }, 401, SAFE_HEADERS);
    return c.json(response, response.reason_code === "rate_limited" ? 429 : 200, SAFE_HEADERS);
  });
  return router;
}
