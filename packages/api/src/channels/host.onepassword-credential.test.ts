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
import { VirtualSandboxProvider } from "@valet/engine";
import { PgSessionStore, PgEventStream } from "@valet/store-postgres";
import { freshTestPgDb, type TestPgDb } from "../test-helpers/pg-test-db.js";
import { EngineHost } from "../engine/host.js";
import { OnePasswordAuthError, type OnePasswordCtx, type OnePasswordService } from "../services/onepassword.js";
import { ChannelHost } from "./host.js";

const orgId = "op-channel-org";

/** Minimal in-memory `CredentialStore` — keyed by `${owner.type}:${owner.id}:${service}`. */
function fakeCredentialStore(): CredentialStore {
  const rows = new Map<string, StoredCredential>();
  const key = (owner: CredentialOwner, service: string) => `${owner.type}:${owner.id}:${service}`;
  return {
    async get(owner, service) {
      return rows.get(key(owner, service)) ?? null;
    },
    async save(owner, service, credential) {
      rows.set(key(owner, service), credential);
    },
    async delete(owner, service) {
      rows.delete(key(owner, service));
    },
    async list() {
      return [];
    },
  };
}

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
    listItems: unused,
    getItem: unused,
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

  async function makeHost(credentials: CredentialStore, onePassword: OnePasswordService): Promise<ChannelHost> {
    testDb = await freshTestPgDb();
    const { pgdb, appDb } = testDb;
    const engineStore = new PgSessionStore(pgdb);
    const eventStream = new PgEventStream(pgdb);
    const createdTransport = new FakeTransport();
    const fakePlugin: ValetPlugin = {
      name: "fake",
      version: "0",
      transports: [{ channelType: "fake", create: () => createdTransport }],
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
    expect(sawCtx).toEqual({ orgId, userId: "" });
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
});
