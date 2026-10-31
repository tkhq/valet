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

/** The `[answered: …]` line for `resolvedAt: 1` with no known timezone. */
const ANSWERED_AT_1 = "[answered: Thursday 1970-01-01 00:00 UTC]";

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
    // The answer time comes first: the stored resolvedAt is 1, and this context knows no timezone.
    expect(result.text).toBe(`${ANSWERED_AT_1}\n\nanswer to "Which workflow first?": PR review`);
  });

  it("prefers a typed answer over an option", async () => {
    const result = await askQuestionTool.execute(
      { question: "Which repo?", options: ["web"] },
      makeCtx(async () => ({ value: " api ", resolvedBy: "u1", resolvedAt: 1 })),
    );
    expect(result.text).toBe(`${ANSWERED_AT_1}\n\nanswer to "Which repo?": api`);
  });

  it("ignores a stored answer that is not text, instead of crashing", async () => {
    // Read back from storage, the way a bad answer would arrive.
    const stored = '{"actionId":"option-0","resolvedBy":"u1","resolvedAt":1,"value":123}';
    const result = await askQuestionTool.execute(
      { question: "Which repo?", options: ["web"] },
      makeCtx(async () => JSON.parse(stored)),
    );
    expect(result.text).toBe(`${ANSWERED_AT_1}\n\nanswer to "Which repo?": web`);
  });

  it("holds work that depends on an expired question, and goes on with the rest", async () => {
    const result = await askQuestionTool.execute(
      { question: "Ship it?" },
      makeCtx(async () => { throw new DecisionGateExpiredError("g1"); }),
    );
    expect(result.text).toContain("Do not ask again in this turn");
    // An unanswered question never licenses the action it was about.
    expect(result.text).toContain("Do not send, change, or delete anything that depends on the answer; say what was missing.");
    expect(result.text).not.toContain("Continue without the answer");
  });
});

it("returns question-answer images as model-visible tool attachments after JSON replay", async () => {
  const resolution: DecisionResolution = { resolvedBy: "u1", resolvedAt: 1,
    attachments: [{ url: "data:image/png;base64,cGhvdG8=", mimeType: "image/png", name: "avatar.png" }] };
  const result = await askQuestionTool.execute({ question: "Which avatar?" }, makeCtx(async () => JSON.parse(JSON.stringify(resolution))));
  expect(result.text).toContain("See the attached images");
  expect(result.attachments).toEqual([{ type: "image", data: new Uint8Array([112, 104, 111, 116, 111]), mimeType: "image/png", name: "avatar.png" }]);
});

it("shows the answer time in the user's timezone, and no time for a stored answer without one", async () => {
  const at = Date.UTC(2026, 9, 13, 16, 35);
  const ctx = (resolvedAt: unknown) => ({
    ...makeCtx(async () => JSON.parse(JSON.stringify({ value: "tomorrow", resolvedBy: "u1", resolvedAt }))),
    currentUserTimezone: async () => "America/Los_Angeles",
  });
  const answered = await askQuestionTool.execute({ question: "When?" }, ctx(at));
  expect(answered.text).toBe(
    "[answered: Tuesday 2026-10-13 16:35 UTC; user local: Tuesday 2026-10-13 09:35 PDT (America/Los_Angeles)]\n\n" +
    'answer to "When?": tomorrow',
  );
  const stored = await askQuestionTool.execute({ question: "When?" }, ctx("not a time"));
  expect(stored.text).toBe('answer to "When?": tomorrow');
});
