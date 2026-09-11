/**
 * Session-backed agent actions must resolve their sender identity when they
 * post through a Slack action. `Session.options` is the engine's public seam.
 */
import { afterEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { bootTestApi, type TestApi } from "../integration/_setup.js";
import { createAssistant } from "../assistants/service.js";
import { assistants } from "../schema/index.js";

const USER = "local-user";
const ORG = "local-org";
const AVATAR_URL = "https://cdn.example.com/release-bot.png";

async function senderFor(session: { options: { resolveOutboundSender?: () => Promise<{ displayName?: string; avatarUrl?: string } | undefined> } }) {
  const resolve = session.options.resolveOutboundSender;
  if (!resolve) throw new Error("session has no outbound sender resolver");
  return resolve();
}

describe("EngineHost outbound sender identity", () => {
  let api: TestApi | undefined;

  afterEach(async () => {
    await api?.cleanup();
    api = undefined;
  });

  it("uses the current default assistant for a workflow session node", async () => {
    api = await bootTestApi({ plugins: [] });
    const assistant = await createAssistant(api.providers.db, ORG, { type: "user", id: USER }, "Release bot");
    await api.providers.db
      .update(assistants)
      .set({ avatarUrl: AVATAR_URL })
      .where(eq(assistants.id, assistant.id));

    const session = await api.providers.engineHost.workflowSessionFor("wf:run1:node1", {
      actorUserId: USER,
      orgId: ORG,
      owner: { type: "user", id: USER },
      workspace: "/tmp",
    });

    expect(await senderFor(session)).toEqual({ displayName: "Release bot", avatarUrl: AVATAR_URL });
  });

  it("uses the current parent assistant for a child-agent session", async () => {
    api = await bootTestApi({ plugins: [] });
    const assistant = await createAssistant(api.providers.db, ORG, { type: "user", id: USER }, "Release bot");
    await api.providers.db
      .update(assistants)
      .set({ avatarUrl: AVATAR_URL })
      .where(eq(assistants.id, assistant.id));

    const session = await api.providers.engineHost.childSessionFor("child:release", {
      parentSessionId: assistant.sessionId,
      parentThreadId: "thread:parent",
      actorUserId: USER,
      orgId: ORG,
      owner: { type: "user", id: USER },
      workspace: "/tmp",
    });
    await api.providers.db
      .update(assistants)
      .set({ name: "Release captain", avatarUrl: null })
      .where(eq(assistants.id, assistant.id));

    expect(await senderFor(session)).toEqual({ displayName: "Release captain" });
  });

  it("keeps the bot identity fallback when a workflow owner has no assistant", async () => {
    api = await bootTestApi({ plugins: [] });
    const session = await api.providers.engineHost.workflowSessionFor("wf:run1:node1", {
      actorUserId: USER,
      orgId: ORG,
      owner: { type: "user", id: USER },
      workspace: "/tmp",
    });

    expect(await senderFor(session)).toBeUndefined();
  });
});
