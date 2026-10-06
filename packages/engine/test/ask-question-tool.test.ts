import { describe, expect, it } from "vitest";
import { askQuestionTool } from "../src/builtin-tools/index.js";
import { DecisionGateExpiredError } from "../src/decision-gate.js";
import type {
  Credential,
  CredentialProvider,
  DecisionGateRequest,
  DecisionResolution,
  MessageQuery,
  Sandbox,
  SessionEntry,
  ToolContext,
} from "../src/types.js";

const stubCredentials: CredentialProvider = {
  get: async (): Promise<Credential | null> => null,
  request: async (): Promise<Credential> => {
    throw new Error("not implemented in test stub");
  },
};

function makeCtx(requestDecision: (gate: DecisionGateRequest) => Promise<DecisionResolution>): ToolContext {
  const sandbox: Partial<Sandbox> & { id: string } = { id: "sb-1" };
  return {
    userId: "u1", orgId: "o1", sessionId: "s1", threadId: "t1",
    credentials: stubCredentials,
    sandbox: sandbox as Sandbox,
    requestDecision,
    signal: new AbortController().signal,
    threadRead: async (_key: string, _opts?: MessageQuery): Promise<SessionEntry[]> => [],
    listThreads: async () => [],
    setModel: async ({ model }: { model: string }) => ({ fromModel: model, toModel: model }),
  };
}

describe("ask_question tool", () => {
  it("opens a question gate with one button per option and returns the picked answer", async () => {
    let seen: DecisionGateRequest | undefined;
    const result = await askQuestionTool.execute(
      { question: "Which workflow first?", options: ["Linear sync", "PR review"], detail: "Both are drafted." },
      makeCtx(async (gate) => { seen = gate; return { actionId: "option-1", resolvedBy: "u1", resolvedAt: 1 }; }),
    );
    expect(seen).toMatchObject({
      type: "question", title: "Which workflow first?", body: "Both are drafted.",
      actions: [{ id: "option-0", label: "Linear sync" }, { id: "option-1", label: "PR review" }],
    });
    expect(result.text).toBe('answer to "Which workflow first?": PR review');
  });

  it("prefers a typed answer over an option", async () => {
    const result = await askQuestionTool.execute(
      { question: "Which repo?", options: ["web"] },
      makeCtx(async () => ({ value: " api ", resolvedBy: "u1", resolvedAt: 1 })),
    );
    expect(result.text).toBe('answer to "Which repo?": api');
  });

  it("ignores a stored answer that is not text, instead of crashing", async () => {
    // Read back from storage, the way a bad answer would arrive.
    const stored = '{"actionId":"option-0","resolvedBy":"u1","resolvedAt":1,"value":123}';
    const result = await askQuestionTool.execute(
      { question: "Which repo?", options: ["web"] },
      makeCtx(async () => JSON.parse(stored)),
    );
    expect(result.text).toBe('answer to "Which repo?": web');
  });

  it("tells the model to go on without asking again when the question expires", async () => {
    const result = await askQuestionTool.execute(
      { question: "Ship it?" },
      makeCtx(async () => { throw new DecisionGateExpiredError("g1"); }),
    );
    expect(result.text).toContain("Do not ask again in this turn");
  });
});

it("returns question-answer images as model-visible tool attachments after JSON replay", async () => {
  const resolution: DecisionResolution = { resolvedBy: "u1", resolvedAt: 1,
    attachments: [{ url: "data:image/png;base64,cGhvdG8=", mimeType: "image/png", name: "avatar.png" }] };
  const result = await askQuestionTool.execute({ question: "Which avatar?" }, makeCtx(async () => JSON.parse(JSON.stringify(resolution))));
  expect(result.text).toContain("See the attached images");
  expect(result.attachments).toEqual([{ type: "image", data: new Uint8Array([112, 104, 111, 116, 111]), mimeType: "image/png", name: "avatar.png" }]);
});
