import { afterEach, describe, expect, it, vi } from "vitest";
import { fauxAssistantMessage, fauxToolCall, registerFauxProvider, type FauxProviderRegistration } from "@earendil-works/pi-ai/compat";
import slackPlugin from "@valet/plugin-slack/plugin";
import { bootTestApi, type TestApi } from "../integration/_setup.js";
import { actionPolicies } from "../schema/index.js";

const USER = "local-user";
const ORG = "local-org";

let faux: FauxProviderRegistration | undefined;

async function allowSlackSend(api: TestApi): Promise<void> {
  const now = Date.now();
  await api.providers.db.insert(actionPolicies).values({
    id: "test:allow:slack.send_message",
    orgId: ORG,
    principalType: "org",
    principalId: ORG,
    service: null,
    actionId: "slack.send_message",
    riskLevel: null,
    mode: "allow",
    paramMatchers: [],
    appliesIn: "session",
    origin: "admin",
    managedBy: null,
    expiresAt: null,
    revokedAt: null,
    createdAt: now,
    updatedAt: now,
  });
  await api.providers.engineCredentials.save(
    { type: "org", id: ORG },
    "slack",
    { type: "bot_token", accessToken: "xoxb-test-token" },
  );
}

function queueSlackSend(): void {
  if (!faux) throw new Error("faux model is not registered");
  faux.setResponses([
    fauxAssistantMessage(
      [
        fauxToolCall(
          "call_tool",
          {
            tool_id: "slack.send_message",
            params: { channel: "C1", text: "from a workflow session" },
            summary: "Send the workflow result",
          },
          { id: "tc-slack-send" },
        ),
      ],
      { stopReason: "toolUse" },
    ),
    fauxAssistantMessage("sent"),
  ]);
}

async function postThroughSession(session: { prompt(content: string): Promise<unknown> }): Promise<Record<string, unknown>> {
  queueSlackSend();
  const fetchMock = vi.fn()
    .mockResolvedValueOnce(new Response(JSON.stringify({ ok: true, channel: { id: "C1", is_private: false, is_im: false, is_mpim: false } })))
    .mockResolvedValueOnce(new Response(JSON.stringify({ ok: true, ts: "1.2", channel: "C1" })));
  vi.stubGlobal("fetch", fetchMock);
  await session.prompt("Send the workflow result.");
  await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
  const [url, init] = fetchMock.mock.calls[1] as [string, RequestInit];
  expect(url).toBe("https://slack.com/api/chat.postMessage");
  return JSON.parse(init.body as string) as Record<string, unknown>;
}

describe("EngineHost Slack actions", () => {
  let api: TestApi | undefined;

  afterEach(async () => {
    faux?.unregister();
    faux = undefined;
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    await api?.cleanup();
    api = undefined;
  });

  it("keeps the installed Slack bot identity for workflow session actions", async () => {
    vi.stubEnv("ANTHROPIC_API_KEY", "fixture-key");
    faux = registerFauxProvider({ api: "anthropic-messages", provider: "anthropic" });
    api = await bootTestApi({ plugins: [slackPlugin] });
    await allowSlackSend(api);

    const session = await api.providers.engineHost.workflowSessionFor("wf:run1:node1", {
      actorUserId: USER,
      orgId: ORG,
      owner: { type: "user", id: USER },
      workspace: "/tmp",
    });

    const body = await postThroughSession(session);
    expect(body).toMatchObject({ channel: "C1", text: "from a workflow session" });
    expect(body.username).toBeUndefined();
    expect(body.icon_url).toBeUndefined();
  });
});
