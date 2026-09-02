/**
 * Owner-precedence contract (1Password credential provider plan, Task 6):
 * `ChannelHost.start()`'s bot-token read must resolve org-owned rows
 * carrying `metadata.onepassword` through `OnePasswordService`, and a
 * resolution failure (`OnePasswordAuthError`) must be caught — logged, that
 * transport simply doesn't start — rather than crashing boot. Drives a real
 * `ChannelHost.start()` against a fake transport factory and a fake
 * `OnePasswordService`, mirroring `engine/host.onepassword-credential.test.ts`'s
 * fakes.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ChannelTransport, CredentialOwner, CredentialStore, StoredCredential, ValetPlugin } from "@valet/engine";
import { InMemoryCredentialStore } from "@valet/engine";
import { VirtualSandboxProvider } from "@valet/engine";
import { PgSessionStore, PgEventStream } from "@valet/store-postgres";
import { freshTestPgDb, type TestPgDb } from "../test-helpers/pg-test-db.js";
import { EngineHost } from "../engine/host.js";
import { OnePasswordAuthError, type OnePasswordCtx, type OnePasswordService, createOnePasswordService } from "../services/onepassword.js";
import { ChannelHost } from "./host.js";

const orgId = "op-channel-org";

const fakeCredentialStore = (): CredentialStore => new InMemoryCredentialStore();

/** Fake `OnePasswordService` — only `resolveCredential` is exercised by `ChannelHost.start()`. */
function fakeOnePassword(
  resolveCredential: OnePasswordService["resolveCredential"],
): OnePasswordService {
  const unused = () => {
    throw new Error("not exercised by this suite");
  };
  return {
    tokenConnected: unused,
    listVaults: unused,
    resolveReference: unused,
    findCredentialForService: async () => null,
    resolveCredential,
  };
}

class FakeTransport implements ChannelTransport {
  readonly channelType = "fake";
  verifyWebhook(): null {
    return null;
  }
  parseUpdate(): null {
    return null;
  }
  async send() {
    return { conversationKey: "fake:dm:1", messageId: "1" };
  }
  async sendMedia() {
    return { conversationKey: "fake:dm:1", messageId: "1" };
  }
  async sendGatePrompt() {
    return { conversationKey: "fake:dm:1", messageId: "1" };
  }
  async updateGatePrompt() {}
}

describe("ChannelHost.start() 1Password bot-token resolution", () => {
  let testDb: TestPgDb | undefined;
  let engineHost: EngineHost | undefined;
  let host: ChannelHost | undefined;

  afterEach(async () => {
    await host?.stop();
    await engineHost?.destroyAll();
    host = undefined;
    engineHost = undefined;
    testDb = undefined;
  });

  async function makeHost(
    credentials: CredentialStore,
    onePassword: OnePasswordService,
    create: (ctx: { credential: StoredCredential }) => ChannelTransport = () => new FakeTransport(),
  ): Promise<ChannelHost> {
    testDb = await freshTestPgDb();
    const { pgdb, appDb } = testDb;
    const engineStore = new PgSessionStore(pgdb);
    const eventStream = new PgEventStream(pgdb);
    const fakePlugin: ValetPlugin = {
      name: "fake",
      version: "0",
      transports: [{ channelType: "fake", create }],
    };
    engineHost = new EngineHost({
      engineStore,
      sandboxProvider: new VirtualSandboxProvider(),
      eventStream,
      engineCredentials: credentials,
      db: appDb,
      apiBaseUrl: "http://127.0.0.1:1",
      plugins: [fakePlugin],
    });
    host = new ChannelHost({
      db: appDb,
      engineHost,
      engineStore,
      eventStream,
      engineCredentials: credentials,
      plugins: [fakePlugin],
      resolveOrgId: async () => orgId,
      onePassword,
    });
    return host;
  }

  it("reference-backed bot token starts the transport with the resolved token", async () => {
    const credentials = fakeCredentialStore();
    const orgRow: StoredCredential = {
      type: "bot_token",
      metadata: { onepassword: { reference: "op://Shared/Bot/token", tokenScope: "org" } },
    };
    await credentials.save({ type: "org", id: orgId }, "fake", orgRow);
    let sawRow: StoredCredential | undefined;
    let sawCtx: OnePasswordCtx | undefined;
    const onePassword = fakeOnePassword(async (row, ctx) => {
      sawRow = row;
      sawCtx = ctx;
      return { type: row.type, metadata: row.metadata, accessToken: "resolved-bot-token" };
    });

    const h = await makeHost(credentials, onePassword);
    await h.start();

    expect(sawRow).toBe(orgRow);
    expect(sawCtx).toEqual({ orgId, userId: "", scopes: ["org"] });
    expect(h.isRunning("fake")).toBe(true);
  });

  it("a failed resolution logs and skips the transport — does not crash boot", async () => {
    const credentials = fakeCredentialStore();
    await credentials.save({ type: "org", id: orgId }, "fake", {
      type: "bot_token",
      metadata: { onepassword: { reference: "op://Shared/Bot/token", tokenScope: "org" } },
    });
    const authError = new OnePasswordAuthError("This org has no organization 1Password service account token connected.");
    const onePassword = fakeOnePassword(async () => {
      throw authError;
    });
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const h = await makeHost(credentials, onePassword);
    await expect(h.start()).resolves.toBeUndefined();

    expect(h.isRunning("fake")).toBe(false);
    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining(`[channels] fake: bot token resolution failed: ${authError.message}`),
    );
    errorSpy.mockRestore();
  });
  // Through the REAL service, not a stub: `resolveCredential` places the
  // secret by row type, and a transport reads one fixed field. The Slack
  // factory reads `accessToken`; this factory does the same.
  const readsAccessToken = (ctx: { credential: StoredCredential }): ChannelTransport => {
    if (!ctx.credential.accessToken) throw new Error("transport requires a bot token");
    return new FakeTransport();
  };

  it("a bot_token reference row resolves into accessToken and the transport starts", async () => {
    const credentials = fakeCredentialStore();
    // The org token the service resolves through.
    const svcStore = new InMemoryCredentialStore();
    await svcStore.save({ type: "org", id: orgId }, "onepassword", { type: "service_account", apiKey: "org-token" });
    const onePassword = createOnePasswordService({
      credentials: svcStore,
      getAllowPersonal: async () => true,
      createClient: async () => ({
        secrets: { resolve: async () => "xoxb-real-bot-token" },
        vaults: { list: async () => [] },
        items: { list: async () => [], getWithSecrets: async () => ({ title: "", fields: [] }) },
      }),
    });
    await credentials.save({ type: "org", id: orgId }, "fake", {
      type: "bot_token",
      metadata: { onepassword: { reference: "op://Shared/Bot/token", tokenScope: "org" } },
    });
    const h = await makeHost(credentials, onePassword, readsAccessToken);
    await h.start();
    expect(h.isRunning("fake")).toBe(true);
  });

  it("an api_key reference row lands in apiKey, which a bot-token transport cannot read", async () => {
    const credentials = fakeCredentialStore();
    const svcStore = new InMemoryCredentialStore();
    await svcStore.save({ type: "org", id: orgId }, "onepassword", { type: "service_account", apiKey: "org-token" });
    const onePassword = createOnePasswordService({
      credentials: svcStore,
      getAllowPersonal: async () => true,
      createClient: async () => ({
        secrets: { resolve: async () => "xoxb-real-bot-token" },
        vaults: { list: async () => [] },
        items: { list: async () => [], getWithSecrets: async () => ({ title: "", fields: [] }) },
      }),
    });
    await credentials.save({ type: "org", id: orgId }, "fake", {
      type: "api_key",
      metadata: { onepassword: { reference: "op://Shared/Bot/token", tokenScope: "org" } },
    });
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const h = await makeHost(credentials, onePassword, readsAccessToken);
    await h.start();
    // This is why PUT /api/credentials holds a reference's type to the plugin's
    // declaration: the save would otherwise verify green and boot would log this.
    expect(h.isRunning("fake")).toBe(false);
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining("[channels] fake: transport not started"), expect.anything());
    errorSpy.mockRestore();
  });
});
