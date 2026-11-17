// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
import type { DecisionGateRequest, DecisionResolution, Sandbox, ToolContext } from "@valet/engine";
import { buildSecretTools, deleteScopeOf, secretRequestAnswerRefusal, secretRequestOf } from "./secret-tools.js";
import { SecretStoreError } from "../services/secret-store/provider.js";
import type { SecretStoreService } from "../services/secret-store/service.js";

function fakeStore(saved: Set<string> = new Set(), removed: Array<{ userId: string; key: string }> = []): SecretStoreService {
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
    remove: async (actor, scope, name) => {
      const key = `${scope.kind}:${name}`;
      if (scope.kind === "company" && actor.userId !== "admin") {
        throw new SecretStoreError("Only an organization admin can change company secrets.", "forbidden");
      }
      saved.delete(key);
      removed.push({ userId: actor.userId, key });
    },
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

describe("delete_secret", () => {
  async function del(store: SecretStoreService, ctx: ToolContext, args: { name: string; scope?: "personal" | "team" | "company" }) {
    const tool = buildSecretTools({ secretStore: store }).find((t) => t.name === "delete_secret");
    return (await tool!.execute(args, ctx)).text ?? "";
  }
  const approveAs = (userId: string) => () => ({ actionId: "approve", resolvedBy: userId, resolvedAt: 0 });

  it("deletes a personal secret only after the person approves a card that names it", async () => {
    const saved = new Set(["personal:TEST_KEY"]);
    const removed: Array<{ userId: string; key: string }> = [];
    const { ctx, gates } = context({ owner: { type: "user", id: "user-a" }, resolve: approveAs("user-a") });
    const text = await del(fakeStore(saved, removed), ctx, { name: "TEST_KEY" });
    expect(gates).toHaveLength(1);
    expect(gates[0]).toMatchObject({ type: "approval", title: "Delete TEST_KEY?", resumeKey: "delete_secret:secret://personal/TEST_KEY" });
    expect(gates[0]!.body).toContain("You cannot undo this.");
    expect(removed).toEqual([{ userId: "user-a", key: "personal:TEST_KEY" }]);
    expect(text).toBe("Deleted secret://personal/TEST_KEY. Commands that reference it now fail.");
  });

  it("keeps the secret when the person does not approve", async () => {
    const removed: Array<{ userId: string; key: string }> = [];
    const { ctx } = context({ owner: { type: "user", id: "user-a" }, resolve: () => ({ actionId: "deny", resolvedBy: "user-a", resolvedAt: 0 }) });
    const text = await del(fakeStore(new Set(["personal:TEST_KEY"]), removed), ctx, { name: "TEST_KEY" });
    expect(removed).toEqual([]);
    expect(text).toContain("It is still saved. Do not delete it another way.");
  });

  it("deletes a team secret as the member who approved", async () => {
    const removed: Array<{ userId: string; key: string }> = [];
    const { ctx } = context({ owner: { type: "team", id: "team-1" }, resolve: approveAs("member-b") });
    await del(fakeStore(new Set(["team:VALET_TEST_KEY"]), removed), ctx, { name: "VALET_TEST_KEY" });
    expect(removed).toEqual([{ userId: "member-b", key: "team:VALET_TEST_KEY" }]);
  });

  it("reports the store's refusal when a non-admin approves a company delete", async () => {
    const { ctx } = context({ owner: { type: "user", id: "user-a" }, resolve: approveAs("user-a") });
    const text = await del(fakeStore(new Set(["company:SHARED"])), ctx, { name: "SHARED", scope: "company" });
    expect(text).toBe("SHARED was not deleted: Only an organization admin can change company secrets.");
  });

  it("opens no card for a missing name, a workflow run, or a scope the session cannot reach", async () => {
    const cases: Array<[Parameters<typeof context>[0], Parameters<typeof del>[2], RegExp]> = [
      [{ owner: { type: "user", id: "user-a" } }, { name: "MISSING" }, /No secret named MISSING in your personal secrets/],
      [{ owner: { type: "user", id: "user-a" }, unattendedWorkflow: true }, { name: "TEST_KEY" }, /workflow run cannot delete/],
      [{ owner: { type: "team", id: "team-1" } }, { name: "TEST_KEY", scope: "personal" }, /team session cannot delete a personal secret/],
      [{ owner: { type: "user", id: "user-a" } }, { name: "secret://personal/TEST_KEY" }, /Pass the saved name/],
    ];
    for (const [opts, args, expected] of cases) {
      const { ctx, gates } = context(opts);
      expect(await del(fakeStore(new Set(["personal:TEST_KEY"])), ctx, args)).toMatch(expected);
      expect(gates).toHaveLength(0);
    }
  });
});

describe("deleteScopeOf", () => {
  it("maps a session to its own scope and allows company from any session", () => {
    expect(deleteScopeOf(undefined, { type: "user", id: "u" })).toEqual({ kind: "personal" });
    expect(deleteScopeOf(undefined, { type: "team", id: "t" })).toEqual({ kind: "team", teamId: "t" });
    expect(deleteScopeOf("company", { type: "team", id: "t" })).toEqual({ kind: "company" });
    expect(deleteScopeOf("team", { type: "user", id: "u" })).toMatch(/personal session cannot delete a team secret/);
    expect(deleteScopeOf(undefined, { type: "org", id: "o" })).toMatch(/only company secrets/);
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
