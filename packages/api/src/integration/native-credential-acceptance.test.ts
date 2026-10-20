/**
 * Acceptance scenario P1-P6 of the native integration credential policy
 * (docs/specs/2026-10-15-native-integration-credential-policy-design.md).
 *
 * One run from a clean start: org `acme` has the Linear app connected,
 * `u-001` has no Linear connection, and `u-002` shares a Linear connection
 * with team `platform`. A stub MCP server stands in for `mcp.linear.app`
 * and records the Authorization header of every request, so each step
 * asserts the bearer token that would reach Linear.
 *
 * The Linear action plugin is the real `mcpActionPlugin` with the options
 * `@valet/plugin-linear` passes, pointed at the stub. Each step reads
 * through a real `EngineHost` session's `credentialProvider()`.
 */
import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  InMemoryEventStream,
  InMemorySessionStore,
  VirtualSandboxProvider,
  type ActionPlugin,
  type CredentialProvider,
  type PluginActionResult,
  type Sandbox,
  type StoredCredential,
  type ValetPlugin,
} from "@valet/engine";
import { mcpActionPlugin } from "@valet/sdk/mcp";
import linearPlugin from "@valet/plugin-linear/plugin";
import slackPlugin from "@valet/plugin-slack/plugin";
import type { AppDb } from "../lib/drizzle.js";
import { freshTestPgDb } from "../test-helpers/pg-test-db.js";
import { deriveSecretKey } from "../lib/secret-crypto.js";
import { teamMembers, teams } from "../schema/index.js";
import { PgCredentialStore } from "../plugins/credential-store.js";
import { revokeShare, shareCredential } from "../services/credential-shares.js";
import { configMcpPlugins } from "../plugins/config-mcp.js";
import { EngineHost } from "../engine/host.js";

const orgId = "acme";
const teamId = "platform";
const APP_TOKEN = "lin-app-token";
const U2_TOKEN = "u-002-linear-token";
const appRow: StoredCredential = {
  type: "oauth2",
  accessToken: APP_TOKEN,
  metadata: { grant: "client_credentials", webhookSecret: "hook-secret-value", workspaceId: "ws-value", connectionId: "conn-value" },
};
const METADATA_LEAKS = ["webhookSecret", "hook-secret-value", "workspaceId", "ws-value", "connectionId", "conn-value", "grant"];

interface Recorded {
  path: string;
  method: string;
  authorization: string | undefined;
}

/** A minimal MCP Streamable HTTP server: JSON responses, one tool. */
function startStubMcp(): Promise<{ server: Server; url: string; requests: Recorded[] }> {
  const requests: Recorded[] = [];
  const server = createServer((req: IncomingMessage, res) => {
    let raw = "";
    req.on("data", (chunk: Buffer) => {
      raw += chunk.toString("utf8");
    });
    req.on("end", () => {
      const body: unknown = raw ? JSON.parse(raw) : {};
      const rpc = typeof body === "object" && body !== null ? body : {};
      const method = "method" in rpc && typeof rpc.method === "string" ? rpc.method : "";
      const id = "id" in rpc ? rpc.id : undefined;
      requests.push({ path: req.url ?? "", method, authorization: req.headers.authorization });
      if (id === undefined) {
        res.writeHead(202).end();
        return;
      }
      const result =
        method === "initialize"
          ? { protocolVersion: "2025-03-26", capabilities: { tools: {} }, serverInfo: { name: "stub-linear", version: "0.0.1" } }
          : method === "tools/list"
            ? { tools: [{ name: "create_comment", description: "Create a comment", inputSchema: { type: "object", properties: { body: { type: "string" } } } }] }
            : { content: [{ type: "text", text: "comment created" }] };
      res.writeHead(200, { "content-type": "application/json", "mcp-session-id": "stub-session" });
      res.end(JSON.stringify({ jsonrpc: "2.0", id, result }));
    });
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as AddressInfo; // listen(0) on TCP always yields AddressInfo
      resolve({ server, url: `http://127.0.0.1:${port}`, requests });
    });
  });
}

/** The provider `call_tool` hands a plugin: a bare `get()` reads the
 * plugin's own service (`plugin-catalog.ts` `scopedCredentialProvider`). */
function scopedTo(provider: CredentialProvider, service: string): CredentialProvider {
  return {
    get: (requested?: string) => provider.get(requested ?? service),
    request: (requested: string, reason: string) => provider.request(requested, reason),
  };
}

/** Full-shape inert Sandbox: MCP actions never touch one. */
function inertSandbox(): Sandbox {
  return {
    id: "acceptance",
    readFile: async () => "",
    readBinary: async () => new Uint8Array(),
    writeFile: async () => {},
    writeBinary: async () => {},
    readdir: async () => [],
    stat: async () => ({ isFile: true, isDirectory: false, size: 0 }),
    mkdir: async () => {},
    rm: async () => {},
    exec: async () => ({ stdout: "", stderr: "", exitCode: 0 }),
  };
}

describe("native credential policy acceptance (P1-P6)", () => {
  let stub: Awaited<ReturnType<typeof startStubMcp>>;
  let appDb: AppDb;
  let credentials: PgCredentialStore;
  let host: EngineHost;
  let linearActions: ActionPlugin;
  let configMcp: ValetPlugin[];

  beforeAll(async () => {
    stub = await startStubMcp();
    const fresh = await freshTestPgDb();
    appDb = fresh.appDb;
    credentials = new PgCredentialStore(fresh.pgdb, deriveSecretKey("acceptance-key"));
    await appDb.insert(teams).values({ id: teamId, orgId, name: "Platform", createdAt: 1 });
    await appDb.insert(teamMembers).values([
      { teamId, userId: "u-001", role: "member" },
      { teamId, userId: "u-002", role: "member" },
    ]);
    // The Linear app connection (org `linear` row, client-credentials grant).
    await credentials.save({ type: "org", id: orgId }, "linear", appRow);
    // u-002 connects Linear and shares it with `platform`; the share is
    // approved for borrowing, so borrow rules let a team session use it.
    await credentials.save({ type: "user", id: "u-002" }, "linear", { type: "oauth2", accessToken: U2_TOKEN });
    await shareCredential(appDb, { teamId, service: "linear", userId: "u-002", createdAt: 1, borrowConsentAt: 1 });
    // P6: a config-declared MCP server, with an app-shaped org row under its
    // name, which it must never receive.
    await credentials.save({ type: "org", id: orgId }, "acme-docs", appRow);

    linearActions = mcpActionPlugin({
      mcpUrl: `${stub.url}/linear`,
      serviceName: "linear",
      defaultRiskLevel: "medium",
      appCredentialService: "linear:app",
      displayName: "Linear",
    });
    configMcp = configMcpPlugins([{ name: "acme-docs", url: `${stub.url}/acme-docs`, auth: "oauth" }], {});
    const linear: ValetPlugin = { ...linearPlugin, actions: [linearActions] };
    host = new EngineHost({
      engineStore: new InMemorySessionStore(),
      sandboxProvider: new VirtualSandboxProvider(),
      eventStream: new InMemoryEventStream(),
      engineCredentials: credentials,
      db: appDb,
      plugins: [linear, slackPlugin, ...configMcp],
      // No GitHub here; the token deps only enable the host's credential resolver.
      githubTokenDeps: { key: deriveSecretKey("cache-key"), apiUrl: stub.url, githubUrl: stub.url },
    });
  });

  afterAll(async () => {
    host?.evictAll();
    await new Promise<void>((resolve) => stub?.server.close(() => resolve()));
  });

  /** Runs `linear.create_comment` through discovery and execute, and returns
   * the result with the bearer token of the tools/call request. */
  async function createComment(session: CredentialProvider, sessionId: string): Promise<{ result: PluginActionResult; bearer: string | undefined }> {
    const provider = scopedTo(session, "linear");
    if (!linearActions.resolveActions) throw new Error("the Linear action plugin discovers its tools");
    const actions = await linearActions.resolveActions({ credentials: provider });
    const action = actions.find((candidate) => candidate.id === "linear.create_comment");
    if (!action) throw new Error("stub tools/list did not offer create_comment");
    const before = stub.requests.length;
    const result = await action.execute({ body: "hello" }, {
      userId: "u-001", orgId, sessionId, threadId: "thread-1", credentials: provider, sandbox: inertSandbox(),
      actionId: action.id, service: "linear",
      signal: AbortSignal.timeout(30_000),
      requestDecision: () => Promise.reject(new Error("MCP actions request no decision")),
      threadRead: () => Promise.reject(new Error("MCP actions read no thread")),
      listThreads: () => Promise.reject(new Error("MCP actions list no threads")),
      setModel: () => Promise.reject(new Error("MCP actions set no model")),
    });
    const call = stub.requests.slice(before).find((request) => request.path === "/linear" && request.method === "tools/call");
    return { result, bearer: call?.authorization };
  }

  const userMeta = (userId: string) => ({ userId, orgId, workspace: "/tmp" });
  const teamMeta = { userId: "u-001", orgId, workspace: "/tmp", ownerType: "team" as const, ownerTeamId: teamId };
  const orgMeta = { userId: "u-001", orgId, workspace: "/tmp", ownerType: "org" as const };

  it("runs P1 to P6 in order", async () => {
    // P1: u-001 has no Linear connection, so the comment is made as the app.
    const p1 = await createComment((await host.sessionFor("sess-p1", userMeta("u-001"))).credentialProvider(), "sess-p1");
    expect(p1.result.success).toBe(true);
    expect(p1.bearer).toBe(`Bearer ${APP_TOKEN}`);

    // P2: u-002's personal session uses u-002's own token.
    const p2 = await createComment((await host.sessionFor("sess-p2", userMeta("u-002"))).credentialProvider(), "sess-p2");
    expect(p2.result.success).toBe(true);
    expect(p2.bearer).toBe(`Bearer ${U2_TOKEN}`);

    // P3: the platform team session uses u-002's shared token.
    const team = await host.sessionFor("sess-p3", teamMeta);
    const p3 = await createComment(team.credentialProvider({ actorId: "u-001" }), "sess-p3");
    expect(p3.result.success).toBe(true);
    expect(p3.bearer).toBe(`Bearer ${U2_TOKEN}`);

    // P4: u-002 revokes the share, and the team agent acts as the app.
    expect(await revokeShare(appDb, { teamId, service: "linear", userId: "u-002" })).toBe(true);
    const p4 = await createComment(team.credentialProvider({ actorId: "u-001" }), "sess-p3");
    expect(p4.result.success).toBe(true);
    expect(p4.bearer).toBe(`Bearer ${APP_TOKEN}`);

    // P5: an org-owned session's plugin read gets `{ accessToken }` only.
    const org = (await host.sessionFor("sess-p5", orgMeta)).credentialProvider();
    for (const service of ["linear", "linear:app"]) {
      const cred = await org.get(service);
      expect(cred?.accessToken).toBe(APP_TOKEN);
      expect(cred?.metadata).toBeUndefined();
      const text = JSON.stringify(cred);
      for (const leaked of METADATA_LEAKS) expect(text).not.toContain(leaked);
    }
    const p5 = await createComment(org, "sess-p5");
    expect(p5.bearer).toBe(`Bearer ${APP_TOKEN}`);

    // P6: a config-declared MCP server with no credential is refused in a
    // team session, and no request reaches it with any token.
    const docs = configMcp.flatMap((plugin) => plugin.actions ?? []).find((actionPlugin) => actionPlugin.service === "acme-docs");
    if (!docs?.resolveActions) throw new Error("the config MCP plugin discovers its tools");
    await expect(docs.resolveActions({ credentials: scopedTo(team.credentialProvider({ actorId: "u-001" }), "acme-docs") })).rejects.toThrow(/no credential/);
    expect(stub.requests.filter((request) => request.path === "/acme-docs")).toEqual([]);

    // Over the whole run, no request to the stub carried the webhook secret.
    for (const request of stub.requests) expect(request.authorization ?? "").not.toContain("hook-secret-value");
  });
});
