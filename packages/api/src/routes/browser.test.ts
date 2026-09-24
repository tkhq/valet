import { afterEach, describe, expect, it, vi } from "vitest";
import { bootTestApi, type TestApi } from "../integration/_setup.js";
import {
  VirtualSandboxProvider,
  type SandboxCommandChannelOptions,
  type SandboxProvider,
} from "@valet/engine";
import { agentSessions } from "../schema/index.js";

describe("browser routes", () => {
  let api: TestApi | undefined;
  afterEach(async () => {
    await api?.cleanup();
    api = undefined;
  });
  async function setup(owner = "local-user") {
    api = await bootTestApi();
    await api.providers.db.insert(agentSessions).values({
      id: "browser-session",
      userId: owner,
      ownerType: "user",
      ownerId: owner,
      orgId: "local-org",
      workspace: "/tmp/browser-session",
      status: "active",
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });
    return `${api.baseUrl}/api/sessions/browser-session/browser`;
  }
  it("reports unsupported providers without creating a browser", async () => {
    const url = await setup();
    const response = await fetch(url);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      enabled: false,
      status: null,
      actorId: "local-user",
    });
    expect(api?.providers.engineHost.liveSession("browser-session")).toBeNull();
  });
  it("hides another owner’s browser", async () => {
    const url = await setup("test-member");
    expect((await fetch(url)).status).toBe(404);
  });
  it("rejects cross-origin browser control before touching the runtime", async () => {
    const url = await setup();
    const response = await fetch(`${url}/control`, {
      method: "POST",
      headers: {
        origin: "https://evil.example",
        "content-type": "application/json",
      },
      body: JSON.stringify({ action: "take" }),
    });
    expect(response.status).toBe(403);
    expect(api?.providers.engineHost.liveSession("browser-session")).toBeNull();
  });
  it("does not issue tickets without a running authorized browser", async () => {
    const url = await setup();
    const response = await fetch(`${url}/ticket`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ scope: "view" }),
    });
    expect(response.status).toBe(409);
  });
  it("rejects caller-supplied browser identity fields", async () => {
    const url = await setup();
    const response = await fetch(`${url}/control`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        action: "take",
        actorId: "other",
        audience: "lifecycle",
      }),
    });
    expect(response.status).toBe(400);
  });
  it.each(["input", "tab"])(
    "accepts shared %s and rejects replies after attachment replacement",
    async (command) => {
      const inner = new VirtualSandboxProvider();
      let callbacks: SandboxCommandChannelOptions | undefined;
      let heldId: string | undefined;
      const close = vi.fn();
      const provider: SandboxProvider = {
        backend: "browser-test",
        capabilities: () => ({
          ...inner.capabilities(),
          browserAutomation: true,
        }),
        status: (id) => inner.status(id),
        restore: (id) => inner.restore(id),
        destroy: (id) => inner.destroy(id),
        create: async (options) => {
          const sandbox = await inner.create(options);
          sandbox.openCommandChannel = async (_command, listeners) => {
            callbacks = listeners;
            return {
              close,
              write: async (data) => {
                const envelope: { id: string; request: { command: string } } =
                  JSON.parse(data);
                if (envelope.request.command === command) {
                  heldId = envelope.id;
                  return;
                }
                listeners.onData(
                  JSON.stringify({
                    id: envelope.id,
                    response: {
                      protocolVersion: "1.0",
                      runtimeId: "runtime",
                      ok: true,
                      cursor: 0,
                      events: [],
                      gap: false,
                      status: {
                        state: "ready",
                        runtimeId: "runtime",
                        protocolVersion: "1.0",
                        capabilities: {},
                        tabs: [],
                        control: null,
                      },
                    },
                  }) + "\n",
                );
              },
            };
          };
          return sandbox;
        },
      };
      api = await bootTestApi({ sandboxProvider: provider });
      const created = await fetch(`${api.baseUrl}/api/sessions`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          workspace: "/tmp/browser-channel-test",
          profile: "headless",
        }),
      });
      const session: unknown = await created.json();
      if (
        !session ||
        typeof session !== "object" ||
        !("id" in session) ||
        typeof session.id !== "string"
      )
        throw new Error("Expected a created test session");
      const url = `${api.baseUrl}/api/sessions/${session.id}/browser`;
      expect((await fetch(`${url}/start`, { method: "POST" })).status).toBe(
        200,
      );
      const reply = fetch(`${url}/${command}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(
          command === "input"
            ? {
                runtimeId: "runtime",
                tabId: "tab",
                documentId: "doc",
                input: { type: "key", key: "x" },
              }
            : { runtimeId: "runtime", action: "new", url: "about:blank" },
        ),
      });
      await vi.waitFor(() => expect(heldId).toBeDefined());
      const live = api.providers.engineHost.liveSession(session.id);
      if (!live || !callbacks)
        throw new Error("Expected a live browser channel");
      await live.attachment.replace();
      callbacks.onData(
        JSON.stringify({
          id: heldId,
          response: {
            protocolVersion: "1.0",
            runtimeId: "old",
            ok: true,
            cursor: 0,
            events: [],
            gap: false,
          },
        }) + "\n",
      );
      expect((await reply).status).toBe(409);
      expect(close).toHaveBeenCalled();
    },
  );
});
