// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
import type { DecisionGateRequest, DecisionResolution, Sandbox, ToolContext } from "@valet/engine";
import { buildSecretTools, secretRequestAnswerRefusal, secretRequestOf } from "./secret-tools.js";
import type { SecretStoreService } from "../services/secret-store/service.js";

function fakeStore(saved: Set<string> = new Set()): SecretStoreService {
  const refuse = async (): Promise<never> => {
    throw new Error("not used");
  };
  return {
    enabled: true,
    providerLabel: "Memory",
    list: refuse,
    beginSave: refuse,
    finishSave: refuse,
    saveValue: refuse,
    remove: refuse,
    mayRead: refuse,
    read: refuse,
    exists: async (_actor, scope, name) => saved.has(`${scope.kind}:${name}`),
  };
}

// request_secret never touches the sandbox; the empty object stands in for it.
const unusedSandbox = {} as Sandbox;

function context(opts: {
  owner?: ToolContext["owner"];
  resolve?: (req: DecisionGateRequest) => DecisionResolution;
  unattendedWorkflow?: boolean;
}): { ctx: ToolContext; gates: DecisionGateRequest[] } {
  const gates: DecisionGateRequest[] = [];
  const ctx: ToolContext = {
    userId: "user-a",
    orgId: "org-1",
    sessionId: "sess-1",
    threadId: "th-1",
    ...(opts.owner ? { owner: opts.owner } : {}),
    ...(opts.unattendedWorkflow ? { unattendedWorkflow: true } : {}),
    credentials: { get: async () => null, request: async () => Promise.reject(new Error("unused")) },
    sandbox: unusedSandbox,
    requestDecision: vi.fn(async (req: DecisionGateRequest) => {
      gates.push(req);
      return opts.resolve ? opts.resolve(req) : { actionId: "decline", resolvedBy: "user-a", resolvedAt: 0 };
    }),
    signal: new AbortController().signal,
    threadRead: async () => [],
    listThreads: async () => [],
    setModel: async ({ model }) => ({ fromModel: model, toModel: model }),
  };
  return { ctx, gates };
}

async function run(store: SecretStoreService, ctx: ToolContext) {
  const [tool] = buildSecretTools({ secretStore: store });
  const result = await tool!.execute({ name: "OPENAI_API_KEY", purpose: "Call the OpenAI API in your script." }, ctx);
  return result.text ?? "";
}

describe("request_secret", () => {
  it("opens a card for a personal session and returns only the reference after a save", async () => {
    const saved = new Set<string>();
    const { ctx, gates } = context({
      owner: { type: "user", id: "user-a" },
      resolve: (req) => {
        saved.add("personal:OPENAI_API_KEY");
        return { actionId: "saved", value: "secret://personal/OPENAI_API_KEY", resolvedBy: "user-a", resolvedAt: 0, gateContext: req.context };
      },
    });
    const text = await run(fakeStore(saved), ctx);
    expect(gates).toHaveLength(1);
    expect(gates[0]!.type).toBe("credential_request");
    expect(secretRequestOf(gates[0]!.context)).toEqual({
      scope: "personal",
      name: "OPENAI_API_KEY",
      purpose: "Call the OpenAI API in your script.",
    });
    expect(text).toContain("secret://personal/OPENAI_API_KEY");
    expect(text).toContain("valet-secrets run --env OPENAI_API_KEY=secret://personal/OPENAI_API_KEY");
  });

  it("asks for a team secret in a team session", async () => {
    const { ctx, gates } = context({ owner: { type: "team", id: "team-1" } });
    await run(fakeStore(), ctx);
    expect(secretRequestOf(gates[0]!.context)).toMatchObject({ scope: "team", teamId: "team-1" });
  });

  it("skips the card when the secret is already saved", async () => {
    const { ctx, gates } = context({ owner: { type: "user", id: "user-a" } });
    const text = await run(fakeStore(new Set(["personal:OPENAI_API_KEY"])), ctx);
    expect(gates).toHaveLength(0);
    expect(text).toContain("Saved as secret://personal/OPENAI_API_KEY");
  });

  it("asks again with replace even when the name is saved, and names the destination", async () => {
    const { ctx, gates } = context({ owner: { type: "user", id: "user-a" } });
    const [tool] = buildSecretTools({ secretStore: fakeStore(new Set(["personal:OPENAI_API_KEY"])) });
    await tool!.execute({ name: "OPENAI_API_KEY", purpose: "The old key was revoked.", sends_to: "api.openai.com", replace: true }, ctx);
    expect(gates).toHaveLength(1);
    expect(gates[0]!.title).toBe("Replace OPENAI_API_KEY");
    expect(gates[0]!.body).toContain("It will be sent to api.openai.com.");
    expect(secretRequestOf(gates[0]!.context)).toMatchObject({ sendsTo: "api.openai.com", replace: true });
  });

  it("tells the agent not to ask in chat after a decline", async () => {
    const { ctx } = context({ owner: { type: "user", id: "user-a" } });
    expect(await run(fakeStore(), ctx)).toContain("Do not ask for it in chat");
  });

  it("refuses an org session and a workflow run without opening a card", async () => {
    for (const opts of [{ owner: { type: "org" as const, id: "org-1" } }, { owner: { type: "user" as const, id: "user-a" }, unattendedWorkflow: true }]) {
      const { ctx, gates } = context(opts);
      const text = await run(fakeStore(), ctx);
      expect(gates).toHaveLength(0);
      expect(text).toMatch(/Settings, Secrets/);
    }
  });

  it("does not report a save it cannot see", async () => {
    const { ctx } = context({
      owner: { type: "user", id: "user-a" },
      resolve: () => ({ actionId: "saved", value: "secret://personal/OPENAI_API_KEY", resolvedBy: "user-a", resolvedAt: 0 }),
    });
    expect(await run(fakeStore(), ctx)).toContain("is not saved");
  });
});

describe("secretRequestAnswerRefusal", () => {
  const request = { scope: "personal" as const, name: "K", purpose: "p" };
  it("allows a decline and the exact reference, and refuses anything else", () => {
    expect(secretRequestAnswerRefusal(request, { actionId: "decline" })).toBeNull();
    expect(secretRequestAnswerRefusal(request, { actionId: "saved", value: "secret://personal/K" })).toBeNull();
    for (const answer of [
      { value: "sk-live-the-actual-key" },
      { actionId: "saved", value: "sk-live-the-actual-key" },
      { actionId: "saved", value: "secret://personal/OTHER" },
      { actionId: "decline", value: "sk-live-the-actual-key" },
      { actionId: "approve" },
    ]) {
      expect(secretRequestAnswerRefusal(request, answer), JSON.stringify(answer)).toMatch(/Never send the value as text/);
    }
  });
});
