import { afterEach, describe, expect, it, vi } from "vitest";
import { seedWorkspaceAssistant } from "../test-helpers/assistant-fixture.js";
import { bootTestApi, type TestApi } from "../integration/_setup.js";
import { agentSessions } from "../schema/index.js";

/**
 * Event wakeups (spec 2026-10-15, Part I): "Coding and assistant prompts
 * also carry the thread link when the deployment has a public URL." The
 * link is per-thread, not per-session, so `host.ts` wires it through the
 * engine's `threadSystemContext` hook (`Session.options`, the engine's
 * public seam) rather than the once-per-session `systemPrompt`.
 */

type ThreadContext = (thread: { id: string; key: string }) => string | undefined;

function threadSystemContextOf(session: { options: { threadSystemContext?: ThreadContext } }): ThreadContext | undefined {
  return session.options.threadSystemContext;
}

const USER = "local-user";
const ORG = "local-org";
const LINK_SENTENCE = (threadId: string) =>
  `This thread's link is https://valet.example.com/threads/${threadId}. Post it when you announce work in a channel, so people can follow the thread.`;

describe("thread link context", () => {
  let api: TestApi | undefined;

  afterEach(async () => {
    vi.unstubAllEnvs();
    await api?.cleanup();
    api = undefined;
  });

  it("names the coding session's thread when the deployment has a public URL", async () => {
    vi.stubEnv("VALET_PUBLIC_URL", "https://valet.example.com");
    api = await bootTestApi({});
    const sessionId = "coding-thread-link";
    const now = Date.now();
    await api.providers.db.insert(agentSessions).values({
      id: sessionId,
      userId: USER,
      orgId: ORG,
      workspace: "/tmp/coding-thread-link",
      status: "active",
      ownerType: "user",
      ownerId: USER,
      profile: "headless",
      createdAt: now,
      updatedAt: now,
    });

    const session = await api.providers.engineHost.sessionFor(sessionId, { userId: USER, orgId: ORG, workspace: "/tmp/coding-thread-link" });
    const threadContext = threadSystemContextOf(session);
    expect(threadContext?.({ id: "t-1", key: "web:default" })).toBe(LINK_SENTENCE("t-1"));
  });

  it("omits the sentence when no public URL is configured", async () => {
    api = await bootTestApi({});
    const sessionId = "coding-thread-link-no-url";
    const now = Date.now();
    await api.providers.db.insert(agentSessions).values({
      id: sessionId,
      userId: USER,
      orgId: ORG,
      workspace: "/tmp/coding-thread-link-no-url",
      status: "active",
      ownerType: "user",
      ownerId: USER,
      profile: "headless",
      createdAt: now,
      updatedAt: now,
    });

    const session = await api.providers.engineHost.sessionFor(sessionId, { userId: USER, orgId: ORG, workspace: "/tmp/coding-thread-link-no-url" });
    const threadContext = threadSystemContextOf(session);
    expect(threadContext?.({ id: "t-1", key: "web:default" })).toBeUndefined();
  });

  it("names the assistant session's thread alongside the existing workflow editor context", async () => {
    vi.stubEnv("VALET_PUBLIC_URL", "https://valet.example.com");
    api = await bootTestApi({});
    const assistant = await seedWorkspaceAssistant(api.providers.db, ORG, { type: "user", id: USER });

    const session = await api.providers.engineHost.assistantSessionFor(assistant.id, { actorUserId: USER, orgId: ORG });
    const threadContext = threadSystemContextOf(session);
    // A plain conversation thread: the link sentence only.
    expect(threadContext?.({ id: "t-2", key: "web:default" })).toBe(LINK_SENTENCE("t-2"));
    // A workflow editor thread: both the link and the existing editor context survive.
    const editorContext = threadContext?.({ id: "t-3", key: "workflow:wf_abc123" });
    expect(editorContext).toContain(LINK_SENTENCE("t-3"));
    expect(editorContext).toContain("This conversation is the visual editor for workflow wf_abc123");
  });

  it("does not carry the thread link into a child session", async () => {
    vi.stubEnv("VALET_PUBLIC_URL", "https://valet.example.com");
    api = await bootTestApi({});
    const assistant = await seedWorkspaceAssistant(api.providers.db, ORG, { type: "user", id: USER });

    const session = await api.providers.engineHost.childSessionFor("child-thread-link", {
      parentSessionId: assistant.sessionId,
      parentThreadId: "thread:parent",
      actorUserId: USER,
      orgId: ORG,
      owner: { type: "user", id: USER },
      workspace: "/tmp/child-thread-link",
    });

    expect(threadSystemContextOf(session)).toBeUndefined();
  });
});
