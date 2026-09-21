import { afterEach, describe, expect, it, vi } from "vitest";
import type { AuthorizationRequest, PolicyDecisionEnvelope } from "@valet/engine/authorization";
import { bootTestApi, type TestApi } from "../integration/_setup.js";
import type { CreateSessionResponse, WireEvent } from "../wire/types.js";
import { createWsFrameGate } from "./ws.js";

let api: TestApi | undefined;
afterEach(async () => { vi.restoreAllMocks(); await api?.cleanup(); api = undefined; });

async function createSession(): Promise<string> {
  const response = await fetch(`${api!.baseUrl}/api/sessions`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ workspace: "/tmp" }) });
  expect(response.status).toBe(201);
  return ((await response.json()) as CreateSessionResponse).id;
}

function effect(value: "allow" | "deny" | "require_approval"): PolicyDecisionEnvelope {
  const digest = "0".repeat(64);
  return {
    schemaVersion: 1, requestId: "test", requestSubjectDigest: digest, inputDigest: digest,
    policyDigest: digest, sourceBundleDigest: digest, evaluator: { kind: "local_valet", engineDigest: digest },
    decision: { effect: value, reasonCode: "test", matchedRuleIds: [], obligations: [], redactions: [], ...(value === "require_approval" ? { approvalRequirement: { tier: "human", approverType: "org", replay: "once" } as const } : {}) },
    decisionDigest: digest, obligationDigest: digest, evaluatedAtMs: 1,
  };
}

async function connect(sessionId: string, afterOpen?: (ws: WebSocket) => void): Promise<{ frames: WireEvent[]; closeCode: number }> {
  const ws = new WebSocket(`${api!.wsUrl}/api/sessions/${sessionId}/ws`);
  const frames: WireEvent[] = [];
  return await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => { ws.close(); reject(new Error(`timed out after ${frames.map((frame) => frame.type).join(",")}`)); }, 5_000);
    ws.onmessage = (event) => {
      const frame = JSON.parse(String(event.data)) as WireEvent;
      frames.push(frame);
      if (frame.type === "init") afterOpen?.(ws);
      if (frame.type === "authorization_refusal") ws.close();
    };
    ws.onclose = (event) => { clearTimeout(timeout); resolve({ frames, closeCode: event.code }); };
    ws.onerror = () => { clearTimeout(timeout); reject(new Error("websocket failed")); };
  });
}

describe("WebSocket canonical authorization", () => {
  it("bounds and serializes protected frame authorization", async () => {
    const gate = createWsFrameGate(2);
    const order: string[] = [];
    let release!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    expect(gate.enqueue(async () => { order.push("first-start"); await held; order.push("first-end"); })).toBe(true);
    expect(gate.enqueue(async () => { order.push("second"); })).toBe(true);
    expect(gate.enqueue(async () => { order.push("overflow"); })).toBe(false);
    expect(gate.pending).toBe(2);
    release();
    await vi.waitFor(() => expect(gate.pending).toBe(0));
    expect(order).toEqual(["first-start", "first-end", "second"]);
  });

  it.each([
    ["session.stream.connect", "deny", "authorization_denied", 4403],
    ["session.stream.connect", "require_approval", "authorization_approval_required", 4409],
    ["session.stream.connect", "throw", "authorization_indeterminate", 4411],
    ["session.stream.subscribe", "deny", "authorization_denied", 4403],
  ] as const)("blocks %s on %s without subscription side effects", async (actionId, result, code, closeCode) => {
    api = await bootTestApi();
    const sessionId = await createSession();
    const subscribe = vi.spyOn(api.providers.eventStream, "subscribe");
    const original = api.providers.canonicalAuthorizationService.authorize.bind(api.providers.canonicalAuthorizationService);
    vi.spyOn(api.providers.canonicalAuthorizationService, "authorize").mockImplementation(async (request: AuthorizationRequest) => {
      const template = request.action.parameters?.template;
      if (template !== `/api/sessions/:id/ws#${actionId}`) return original(request);
      if (result === "throw") throw new Error("evaluator unavailable");
      return effect(result);
    });
    const outcome = await connect(sessionId);
    expect(outcome.closeCode).toBe(closeCode);
    expect(outcome.frames).toContainEqual(expect.objectContaining({ type: "authorization_refusal", code }));
    expect(subscribe).not.toHaveBeenCalled();
  });

  it("uses a fresh decision for each repeated frame", async () => {
    api = await bootTestApi();
    const sessionId = await createSession();
    const original = api.providers.canonicalAuthorizationService.authorize.bind(api.providers.canonicalAuthorizationService);
    const deliveries: string[] = [];
    vi.spyOn(api.providers.canonicalAuthorizationService, "authorize").mockImplementation(async (request: AuthorizationRequest) => {
      if (request.action.id !== "api_sessions.ws_pong") return original(request);
      deliveries.push(request.requestId);
      return effect(deliveries.length === 1 ? "allow" : "deny");
    });
    const outcome = await connect(sessionId, (ws) => {
      ws.send(JSON.stringify({ type: "pong" }));
      ws.send(JSON.stringify({ type: "pong" }));
    });
    expect(outcome.frames).toContainEqual(expect.objectContaining({ type: "authorization_refusal", code: "authorization_denied" }));
    expect(new Set(deliveries).size).toBe(2);
  });

  it.each(["subscribe", "pong"] as const)("refuses a denied %s frame without another subscription", async (frameType) => {
    api = await bootTestApi();
    const sessionId = await createSession();
    const subscribe = vi.spyOn(api.providers.eventStream, "subscribe");
    const original = api.providers.canonicalAuthorizationService.authorize.bind(api.providers.canonicalAuthorizationService);
    let openingSubscribe = true;
    vi.spyOn(api.providers.canonicalAuthorizationService, "authorize").mockImplementation(async (request: AuthorizationRequest) => {
      const expected = frameType === "subscribe" ? "api_sessions.ws_subscribe" : "api_sessions.ws_pong";
      if (request.action.id === expected) {
        if (frameType === "subscribe" && openingSubscribe) { openingSubscribe = false; return original(request); }
        return effect("deny");
      }
      return original(request);
    });
    const outcome = await connect(sessionId, (ws) => ws.send(JSON.stringify({ type: frameType })));
    expect(outcome.frames).toContainEqual(expect.objectContaining({ type: "authorization_refusal", code: "authorization_denied" }));
    expect(subscribe).toHaveBeenCalledTimes(1);
  });
});
