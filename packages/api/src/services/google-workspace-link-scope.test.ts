import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Type } from "typebox";
import { googleWorkspacePlugin } from "@valet/plugin-google-workspace/actions";
import { InMemorySessionStore, InMemoryCredentialStore, VirtualSandbox, type PluginAction, type PluginActionContext, type ValetPlugin } from "@valet/engine";
import type { WorkflowRun } from "@valet/workflow";
import { freshTestPgDb } from "../test-helpers/pg-test-db.js";
import { workflowDefinitions } from "../schema/index.js";
import { assemblePlugins, pluginSessionExtras } from "../plugins/assemble.js";
import { buildActionInvoker } from "../plugins/action-invoker.js";
import { GoogleWorkspaceLinkScope, linkedDriveFileId, bindLinkedDriveThread, recordLinkedDrivePrompt } from "./google-workspace-link-scope.js";
import { pluginStore } from "./plugin-store.js";

const owner = { type: "team", id: "legal" } satisfies PluginActionContext["owner"];
const slackMessage = (text: string, overrides: Record<string, unknown> = {}) => ({
  type: "event_callback", event: { type: "app_mention", user: "U123", channel: "C123", ts: "100.001", text, ...overrides },
});

function context(overrides: Partial<PluginActionContext> = {}): PluginActionContext {
  return {
    userId: "user1", orgId: "org1", owner, sessionId: "assistant1", threadId: "thread1", sessionPurpose: "orchestrator",
    actionId: "docs.read_document", service: "google_workspace",
    credentials: { get: async () => ({ accessToken: "token" }), request: async () => { throw new Error("unused"); } },
    sandbox: new VirtualSandbox("test"),
    signal: new AbortController().signal, requestDecision: async () => ({ actionId: "approve", resolvedBy: "user1", resolvedAt: 0 }),
    threadRead: async () => [], listThreads: async () => [], setModel: async ({ model }) => ({ fromModel: model, toModel: model }),
    ...overrides,
  };
}

function fixturePlugin(execute: PluginAction["execute"] = vi.fn(async (_args: unknown, _ctx: PluginActionContext) => ({ success: true, data: "read" })), service = "google_workspace"): ValetPlugin {
  return { name: "google-workspace", version: "1", actions: [{ service, credentialService: "google_workspace", actions: [
    "docs.read_document", "docs.add_comment", "drive.download_file", "drive.list_files", "drive.copy_file", "docs.new_action", "constructor", "sheets.read_spreadsheet",
  ].map((id) => ({ id, name: id, description: id, riskLevel: "low", parameters: Type.Object({
    documentId: Type.Optional(Type.String()), fileId: Type.Optional(Type.String()),
  }), execute })) }] };
}

function action(scope: GoogleWorkspaceLinkScope, id = "docs.read_document", plugin = fixturePlugin()) {
  const found = scope.wrapPlugins([plugin])[0]?.actions?.[0]?.actions?.find((candidate) => candidate.id === id);
  if (!found) throw new Error("fixture action missing");
  return found;
}

describe("linked Drive scope", () => {
  afterEach(() => vi.restoreAllMocks());
  let scope: GoogleWorkspaceLinkScope;
  let engineStore: InMemorySessionStore;
  let db: Awaited<ReturnType<typeof freshTestPgDb>>["appDb"];
  let run: WorkflowRun | null;
  const buildScope = () => new GoogleWorkspaceLinkScope({ db, engineStore, getRun: async () => run });

  beforeEach(async () => {
    db = (await freshTestPgDb()).appDb;
    run = null;
    engineStore = new InMemorySessionStore();
    await engineStore.saveSession({ id: "assistant1", userId: "user1", orgId: "org1", owner, workspace: "/tmp", purpose: "orchestrator", status: "running", createdAt: 0, updatedAt: 0 });
    for (const [id, key] of [["thread1", "slack:C123:100.001"], ["thread2", "slack:C123:200.001"]]) {
      await engineStore.saveThread("assistant1", { id, sessionId: "assistant1", key, status: "active", queueMode: "followup", createdAt: 0, updatedAt: 0 });
      await bindLinkedDriveThread(db, { orgId: "org1", owner, sessionId: "assistant1", threadId: id, threadKey: key });
    }
    scope = buildScope();
  });

  it("allows only human-linked files, keeps follow-ups durable, and normalizes the checked target", async () => {
    const execute = vi.fn(async (_args: unknown, _ctx: PluginActionContext) => ({ success: true }));
    const read = action(scope, "docs.read_document", fixturePlugin(execute));
    expect((await read.execute({ documentId: "fileA" }, context())).success).toBe(false);
    expect(execute).not.toHaveBeenCalled();
    await scope.recordSlackMessage("org1", slackMessage("<https://docs.google.com/document/d/fileA/edit|contract>"));
    expect((await read.execute({ documentId: "https://docs.google.com/document/d/fileA/edit" }, context())).success).toBe(true);
    expect(execute.mock.calls[0]?.[0]).toEqual({ documentId: "fileA" });
    expect((await read.execute({ documentId: "fileB", linkedFileIds: ["fileB"] }, context())).success).toBe(false);
    await scope.recordSlackMessage("org1", slackMessage("https://drive.google.com/file/d/fileB/view", { thread_ts: "100.001", ts: "101.002" }));
    scope = buildScope(); // Rebuild the service; grants live in Postgres.
    expect((await action(scope).execute({ documentId: "fileB" }, context())).success).toBe(true);
    expect((await action(scope, "docs.add_comment").execute({ documentId: "fileA" }, context())).success).toBe(true);
  });

  it("isolates threads, channels, teams, organizations, and child sessions", async () => {
    await scope.recordSlackMessage("org1", slackMessage("https://docs.google.com/document/d/fileA/edit"));
    const read = action(scope);
    expect((await read.execute({ documentId: "fileA" }, context({ threadId: "thread2" }))).success).toBe(false);
    expect((await read.execute({ documentId: "fileA" }, context({ owner: undefined }))).success).toBe(false);
    const session = await engineStore.getSession("assistant1");
    if (!session) throw new Error("fixture session missing");
    for (const changed of [{ ...session, orgId: "org2" }, { ...session, owner: { type: "team", id: "other" } satisfies PluginActionContext["owner"] }, { ...session, purpose: "child" as const }]) {
      await engineStore.saveSession(changed);
      expect((await read.execute({ documentId: "fileA" }, context())).success).toBe(false);
    }
  });

  it.each([
    { bot_id: "B123" }, { bot_profile: {} }, { subtype: "message_changed" }, { user: undefined },
    { channel: "C999" }, { type: "reaction_added" }, { text: "bot says see fileA", attachments: [{ text: "https://docs.google.com/document/d/fileA/edit" }] },
  ])("does not authorize non-human or out-of-channel content: %j", async (overrides) => {
    await scope.recordSlackMessage("org1", slackMessage("https://docs.google.com/document/d/fileA/edit", overrides));
    expect((await action(scope).execute({ documentId: "fileA" }, context())).success).toBe(false);
  });

  it("denies caller-created Slack-looking threads without a routed binding", async () => {
    await scope.recordSlackMessage("org1", slackMessage("https://docs.google.com/document/d/fileA/edit"));
    await engineStore.saveThread("assistant1", { id: "forged", sessionId: "assistant1", key: "slack:C123:100.001", status: "active", queueMode: "followup", createdAt: 0, updatedAt: 0 });
    expect((await action(scope).execute({ documentId: "fileA" }, context({ threadId: "forged" }))).success).toBe(false);
  });

  it("does not accept another organization's ingress", async () => {
    await scope.recordSlackMessage("org2", slackMessage("https://docs.google.com/document/d/fileA/edit"));
    expect((await action(scope).execute({ documentId: "fileA" }, context())).success).toBe(false);
  });

  it.each(["drive.list_files", "drive.copy_file", "docs.new_action", "constructor", "sheets.read_spreadsheet"])("denies unsupported action %s even with a linked target", async (id) => {
    await scope.recordSlackMessage("org1", slackMessage("https://drive.google.com/file/d/fileA/view"));
    expect((await action(scope, id).execute({ fileId: "fileA", documentId: "fileA", [String(Object)]: "fileA" }, context())).success).toBe(false);
  });

  it("leaves personal integrations unchanged and denies credential aliases", async () => {
    expect((await action(scope).execute({ documentId: "fileA" }, context({ owner: { type: "user", id: "user1" } }))).success).toBe(true);
    await scope.recordSlackMessage("org1", slackMessage("https://drive.google.com/file/d/fileA/view"));
    expect((await action(scope, "docs.read_document", fixturePlugin(undefined, "alias")).execute({ documentId: "fileA" }, context())).success).toBe(false);
  });

  it("fails closed when scope storage or thread lookup fails", async () => {
    vi.spyOn(engineStore, "getSession").mockRejectedValueOnce(new Error("offline"));
    const result = await action(scope).execute({ documentId: "fileA" }, context());
    expect(result.success).toBe(false);
    expect(result.error).toContain("unavailable");
  });

  it("uses validated workflow origins for session nodes and real headless invocation", async () => {
    await scope.recordSlackMessage("org1", slackMessage("https://docs.google.com/document/d/fileA/edit"));
    await db.insert(workflowDefinitions).values({ id: "def1", orgId: "org1", ownerType: "team", ownerId: "legal", name: "review", definition: {}, createdAt: 0, updatedAt: 0 });
    run = { runId: "run1", status: "running", waitingOn: [], updatedAt: 0, params: { workflowId: "def1", definitionVersionId: "v1", origin: { assistantSessionId: "assistant1", threadId: "thread1" } }, definition: {}, definitionVersionId: "v1", attempt: 1, wakeRequested: false, createdAt: 0, owner: { ownerType: "team", ownerId: "legal" } };
    expect((await action(scope).execute({ documentId: "fileA" }, context({ sessionId: "wf:run1:review", sessionPurpose: "workflow" }))).success).toBe(true);
    const assembled = assemblePlugins([scope.wrapPlugins([fixturePlugin()])]);
    const invoke = buildActionInvoker({ db, credentials: new InMemoryCredentialStore(), ...assembled });
    const result = await invoke({ invocationId: "workflow:run1:review", service: "google_workspace", action: "docs.read_document", params: { documentId: "fileA" } }, { userId: "user1", orgId: "org1", owner });
    expect(result).toMatchObject({ ok: true });
    run.params.origin = { assistantSessionId: "assistant1", threadId: "thread2" };
    expect((await action(scope).execute({ documentId: "fileA" }, context({ sessionId: "wf:run1:review", sessionPurpose: "workflow" }))).success).toBe(false);
    run.params.origin = undefined;
    expect((await action(scope).execute({ documentId: "fileA" }, context({ sessionId: "wf:run1:review", sessionPurpose: "workflow" }))).success).toBe(false);
  });

  it("propagates Linear issue links to the same run and accepts explicit trigger refs", async () => {
    await db.insert(workflowDefinitions).values({ id: "def-linear", orgId: "org1", ownerType: "team", ownerId: "legal", name: "review", definition: {}, createdAt: 0, updatedAt: 0 });
    run = {
      runId: "run-linear", status: "running", waitingOn: [], updatedAt: 0,
      params: {
        workflowId: "def-linear", definitionVersionId: "v1",
        input: { type: "manual", data: { key: "linear.issue.create", refs: {}, payload: { identifier: "LEG-11" } } },
      },
      definition: {}, definitionVersionId: "v1", attempt: 1, wakeRequested: false, createdAt: 0,
      owner: { ownerType: "team", ownerId: "legal" },
    };
    const read = action(scope);
    const workflowContext = context({ sessionId: "wf:run-linear:fetch", sessionPurpose: "workflow" });
    await scope.recordCanonicalWorkflowAction({
      request: { invocationId: "workflow:run-linear:fetch", service: "linear", action: "linear.get_issue", params: {} },
      context: { orgId: "org1", owner, workflowExecutionId: "run-linear" },
      result: { ok: true, result: { description: "Review https://docs.google.com/document/d/from-linear/edit" } },
    });
    expect((await read.execute({ documentId: "from-linear" }, workflowContext)).success).toBe(true);
    expect((await read.execute({ documentId: "not-in-linear" }, workflowContext)).success).toBe(false);

    run.params.input = {
      type: "manual",
      data: { key: "linear.issue.create", refs: { contract: "https://drive.google.com/file/d/forged-ref/view" }, payload: { identifier: "LEG-12" } },
    };
    expect((await read.execute({ documentId: "forged-ref" }, workflowContext)).success).toBe(false);
    run.params.input = {
      type: "event",
      data: { key: "linear.issue.create", refs: { contract: "https://drive.google.com/file/d/explicit-ref/view" }, payload: { identifier: "LEG-12" } },
    };
    expect((await read.execute({ documentId: "explicit-ref" }, workflowContext)).success).toBe(true);

    await scope.recordCanonicalWorkflowAction({
      request: { invocationId: "workflow:run-linear:comments", service: "linear", action: "linear.get_issue", params: {} },
      context: { orgId: "org1", owner, workflowExecutionId: "run-linear" },
      result: { ok: true, result: { description: "no link", attachments: ["https://docs.google.com/document/d/attachment/edit"], comments: [{ body: "https://docs.google.com/document/d/comment/edit" }], metadata: { url: "https://docs.google.com/document/d/metadata/edit" } } },
    });
    expect((await read.execute({ documentId: "attachment" }, workflowContext)).success).toBe(false);
    expect((await read.execute({ documentId: "comment" }, workflowContext)).success).toBe(false);
    expect((await read.execute({ documentId: "metadata" }, workflowContext)).success).toBe(false);
    await scope.recordCanonicalWorkflowAction({
      request: { invocationId: "workflow:run-linear:search", service: "linear", action: "search_issues", params: {} },
      context: { orgId: "org1", owner, workflowExecutionId: "run-linear" },
      result: { ok: true, result: { description: "https://docs.google.com/document/d/other-action/edit" } },
    });
    expect((await read.execute({ documentId: "other-action" }, workflowContext)).success).toBe(false);

    run = { ...run, runId: "run_01J2Q5A7K3M8N4P6R9S0T1V2W3" };
    const capContext = context({ sessionId: "wf:run_01J2Q5A7K3M8N4P6R9S0T1V2W3:fetch", sessionPurpose: "workflow" });
    const firstLinks = Array.from({ length: 100 }, (_, i) => `https://docs.google.com/document/d/cap${i}/edit`).join(" ");
    const secondLinks = Array.from({ length: 100 }, (_, i) => `https://docs.google.com/document/d/cap${i + 100}/edit`).join(" ");
    await Promise.all([["workflow:run_01J2Q5A7K3M8N4P6R9S0T1V2W3:cap-a", firstLinks], ["workflow:run_01J2Q5A7K3M8N4P6R9S0T1V2W3:cap-b", secondLinks]].map(([invocationId, description]) =>
      scope.recordCanonicalWorkflowAction({
        request: { invocationId, service: "linear", action: "linear.get_issue", params: {} },
        context: { orgId: "org1", owner, workflowExecutionId: "run_01J2Q5A7K3M8N4P6R9S0T1V2W3" },
        result: { ok: true, result: { description } },
      }),
    ));
    const grants = await pluginStore(db, "valet").org("org1").list("linked-drive-workflow-files", { limit: 200 });
    expect(grants.items.filter((grant) => grant.key.includes("run_01J2Q5A7K3M8N4P6R9S0T1V2W3") && (grant.doc as { source?: string }).source === "linear_issue_description")).toHaveLength(100);
    expect((await read.execute({ documentId: "cap99" }, capContext)).success).toBe(true);
    expect((await read.execute({ documentId: "cap100" }, capContext)).success).toBe(false);
  });

  it("guards the real Google actions and never follows embedded links or shortcuts", async () => {
    const real: ValetPlugin = { name: "google-workspace", version: "1", actions: [googleWorkspacePlugin] };
    await scope.recordSlackMessage("org1", slackMessage("https://docs.google.com/document/d/fileA/edit"));
    const fetch = vi.spyOn(globalThis, "fetch").mockResolvedValue(Response.json({
      documentId: "fileA", title: "Contract", body: { content: [{ paragraph: { elements: [{ textRun: { content: "https://docs.google.com/document/d/fileB/edit" } }] } }] },
    }));
    expect((await action(scope, "docs.read_document", real).execute({ documentId: "fileA" }, context())).success).toBe(true);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(String(fetch.mock.calls[0]?.[0])).toContain("/documents/fileA?");
    expect((await action(scope, "docs.read_document", real).execute({ documentId: "fileB" }, context())).success).toBe(false);
    expect(fetch).toHaveBeenCalledTimes(1);
    fetch.mockReset().mockResolvedValue(Response.json({ id: "fileA", name: "shortcut", mimeType: "application/vnd.google-apps.shortcut", shortcutDetails: { targetId: "fileB" } }));
    expect((await action(scope, "drive.download_file", real).execute({ fileId: "fileA" }, context())).success).toBe(false);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(String(fetch.mock.calls[0]?.[0])).toContain("/files/fileA?");
  });

  const sitePrompt = (args: { sessionId?: string; threadId: string; threadKey: string; text: string; purpose?: string }) =>
    recordLinkedDrivePrompt(db, {
      orgId: "org1", owner, sessionId: args.sessionId ?? "assistant1", threadId: args.threadId, threadKey: args.threadKey,
      purpose: args.purpose ?? "orchestrator", text: args.text,
    });

  it("grants a file linked in the site chat without granting another assistant the same thread key", async () => {
    await engineStore.saveThread("assistant1", { id: "site", sessionId: "assistant1", key: "web:default", status: "active", queueMode: "followup", createdAt: 0, updatedAt: 0 });
    await engineStore.saveThread("assistant1", { id: "site-b", sessionId: "assistant1", key: "web:t-other", status: "active", queueMode: "followup", createdAt: 0, updatedAt: 0 });
    await sitePrompt({ threadId: "site", threadKey: "web:default", text: "review https://docs.google.com/document/d/fileA/edit" });
    expect((await action(scope).execute({ documentId: "fileA" }, context({ threadId: "site" }))).success).toBe(true);
    expect((await action(scope).execute({ documentId: "fileA" }, context({ threadId: "site-b" }))).success).toBe(false);
    expect((await action(scope).execute({ documentId: "fileA" }, context())).success).toBe(false);

    await engineStore.saveSession({ id: "assistant2", userId: "user1", orgId: "org1", owner, workspace: "/tmp", purpose: "orchestrator", status: "running", createdAt: 0, updatedAt: 0 });
    await engineStore.saveThread("assistant2", { id: "site2", sessionId: "assistant2", key: "web:default", status: "active", queueMode: "followup", createdAt: 0, updatedAt: 0 });
    expect((await action(scope).execute({ documentId: "fileA" }, context({ sessionId: "assistant2", threadId: "site2" }))).success).toBe(false);
  });

  it("records a site prompt on a Slack thread that routing already bound", async () => {
    await sitePrompt({ threadId: "thread1", threadKey: "slack:C123:100.001", text: "https://drive.google.com/file/d/fileA/view" });
    expect((await action(scope).execute({ documentId: "fileA" }, context())).success).toBe(true);
    expect((await action(scope).execute({ documentId: "fileA" }, context({ threadId: "thread2" }))).success).toBe(false);
  });

  it("does not let a site prompt bind or grant a Slack-looking thread", async () => {
    await engineStore.saveThread("assistant1", { id: "forged-site", sessionId: "assistant1", key: "slack:C999:300.001", status: "active", queueMode: "followup", createdAt: 0, updatedAt: 0 });
    await sitePrompt({ threadId: "forged-site", threadKey: "slack:C999:300.001", text: "https://docs.google.com/document/d/fileA/edit" });
    expect((await action(scope).execute({ documentId: "fileA" }, context({ threadId: "forged-site" }))).success).toBe(false);
    expect((await action(scope).execute({ documentId: "fileA" }, context())).success).toBe(false);
  });

  it("ignores site prompts from a child session", async () => {
    await engineStore.saveThread("assistant1", { id: "site", sessionId: "assistant1", key: "web:default", status: "active", queueMode: "followup", createdAt: 0, updatedAt: 0 });
    await sitePrompt({ threadId: "site", threadKey: "web:default", purpose: "child", text: "https://docs.google.com/document/d/fileA/edit" });
    expect((await action(scope).execute({ documentId: "fileA" }, context({ threadId: "site" }))).success).toBe(false);
  });

  it("uses a site-linked file for a workflow started from that chat", async () => {
    await engineStore.saveThread("assistant1", { id: "site", sessionId: "assistant1", key: "web:default", status: "active", queueMode: "followup", createdAt: 0, updatedAt: 0 });
    await sitePrompt({ threadId: "site", threadKey: "web:default", text: "https://docs.google.com/document/d/fileA/edit" });
    await db.insert(workflowDefinitions).values({ id: "def-site", orgId: "org1", ownerType: "team", ownerId: "legal", name: "review", definition: {}, createdAt: 0, updatedAt: 0 });
    run = { runId: "run-site", status: "running", waitingOn: [], updatedAt: 0, params: { workflowId: "def-site", definitionVersionId: "v1", origin: { assistantSessionId: "assistant1", threadId: "site" } }, definition: {}, definitionVersionId: "v1", attempt: 1, wakeRequested: false, createdAt: 0, owner: { ownerType: "team", ownerId: "legal" } };
    expect((await action(scope).execute({ documentId: "fileA" }, context({ sessionId: "wf:run-site:review", sessionPurpose: "workflow" }))).success).toBe(true);
  });

  it("keeps the restriction in the interactive catalog", async () => {
    const { tools } = pluginSessionExtras(scope.wrapPlugins([fixturePlugin()]));
    const call = tools.find((tool) => tool.name === "call_tool");
    if (!call) throw new Error("catalog missing call_tool");
    const result = await call.execute({ tool_id: "docs.read_document", summary: "Read linked contract", params: { documentId: "fileA" } }, context());
    expect(JSON.stringify(result)).toContain("outside this thread");
  });
});

describe("linked Drive parsing", () => {
  it.each(["https://drive.google.com/file/d/abc_123/view", "https://drive.google.com/open?id=abc_123", "https://docs.google.com/document/d/abc_123/edit"])("accepts direct link %s", (url) => expect(linkedDriveFileId(url)).toBe("abc_123"));
  it.each(["abc_123", "https://drive.google.com/drive/folders/abc_123", "http://docs.google.com/document/d/abc_123", "https://docs.google.com.evil.test/document/d/abc_123", "https://docs.google.com@evil.test/document/d/abc_123", "https://drive.google.com/open?id=abc&id=def", "https://docs.google.com/document/d/%2Fother", "https://docs.google.com/document/d/../../other"])("rejects %s", (url) => expect(linkedDriveFileId(url)).toBeNull());

});
