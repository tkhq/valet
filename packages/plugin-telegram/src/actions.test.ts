import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  Credential,
  CredentialProvider,
  DecisionGateRequest,
  DecisionResolution,
  MessageQuery,
  Sandbox,
  SessionEntry,
  ToolContext,
} from "@valet/engine";
import { telegramPlugin } from "./actions.js";

function credentials(credential: Credential | null): CredentialProvider {
  return {
    get: async () => credential,
    request: async () => { throw new Error("not implemented in test stub"); },
  };
}

function context(overrides: Partial<ToolContext> = {}): ToolContext & { actionId: string; service: string } {
  return {
    userId: "u1",
    orgId: "o1",
    sessionId: "s1",
    threadId: "t1",
    credentials: credentials({ accessToken: "token" }),
    sandbox: { id: "sandbox" } as Sandbox,
    requestDecision: async (_gate: DecisionGateRequest): Promise<DecisionResolution> => { throw new Error("not implemented in test stub"); },
    signal: new AbortController().signal,
    threadRead: async (_key: string, _opts?: MessageQuery): Promise<SessionEntry[]> => [],
    listThreads: async () => [],
    setModel: async ({ model }) => ({ fromModel: model, toModel: model }),
    actionId: "telegram.reply_to_origin",
    service: "telegram",
    ...overrides,
  };
}

function replyAction() {
  const found = telegramPlugin.actions.find((action) => action.id === "telegram.reply_to_origin");
  if (!found) throw new Error("telegram.reply_to_origin is not registered");
  return found;
}

describe("telegram.reply_to_origin", () => {
  const fetchMock = vi.fn();

  beforeEach(() => {
    fetchMock.mockReset();
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => vi.unstubAllGlobals());

  it("posts exactly once to the origin chat", async () => {
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ ok: true, result: { message_id: 42 } })));
    const result = await replyAction().execute(
      { text: "Done" },
      context({ origin: { channelType: "telegram", threadKey: "telegram:99" } }),
    );

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://api.telegram.org/bottoken/sendMessage");
    expect(JSON.parse(init.body as string)).toMatchObject({ chat_id: "99", text: "Done" });
    expect(result).toEqual({ success: true, data: { chatId: "99", messageId: 42 } });
  });

  it("does not post without a Telegram origin", async () => {
    const result = await replyAction().execute({ text: "Done" }, context());
    expect(result).toMatchObject({ success: false });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
