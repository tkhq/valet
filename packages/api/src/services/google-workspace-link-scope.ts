import { and, eq } from "drizzle-orm";
import type { PluginAction, PluginActionContext, Principal, SessionStore, ValetPlugin } from "@valet/engine";
import type { WorkflowStore } from "@valet/workflow";
import type { AppDb } from "../lib/drizzle.js";
import { workflowDefinitions } from "../schema/index.js";
import { pluginStore } from "./plugin-store.js";

const COLLECTION = "linked-drive-files";
const THREADS = "linked-drive-threads";
const ID = /^[a-zA-Z0-9_-]+$/;
const SLACK_THREAD = /^slack:[CG][A-Z0-9]+:\d+\.\d+$/;
const SITE_THREAD = /^web:[A-Za-z0-9][A-Za-z0-9_-]*$/;
const DENIED = "This Google action is outside this thread's allowed file scope. Post the contract's direct Drive or Docs link in this conversation, on the site or in Slack.";
const TARGETS: Readonly<Record<string, string>> = {
  "drive.get_document_info": "fileId",
  "drive.download_file": "fileId",
  "docs.read_document": "documentId",
  "docs.list_tabs": "documentId",
  "docs.list_comments": "documentId",
  "docs.get_comment": "documentId",
  "docs.add_comment": "documentId",
  "docs.reply_to_comment": "documentId",
};

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Only direct file links confer access. Neither folder URLs nor arbitrary ID strings do. */
export function linkedDriveFileId(value: string): string | null {
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" || url.username || url.password || url.port) return null;
    let id: string | null = null;
    if (url.hostname === "docs.google.com") id = url.pathname.match(/^\/document\/d\/([a-zA-Z0-9_-]+)(?:\/|$)/)?.[1] ?? null;
    if (url.hostname === "drive.google.com") {
      id = url.pathname.match(/^\/file\/d\/([a-zA-Z0-9_-]+)(?:\/|$)/)?.[1] ?? null;
      if (url.pathname === "/open" && url.searchParams.getAll("id").length === 1) id = url.searchParams.get("id");
    }
    return id && ID.test(id) ? id : null;
  } catch {
    return null;
  }
}

/** Direct file ids written in a person's own message. Folder URLs and bare ids do not count. */
export function linkedDriveFileIds(text: string): string[] {
  const ids = new Set<string>();
  // Attachment and unfurl text is not part of `text`, so it never grants access.
  for (const match of text.matchAll(/https:\/\/[^\s<>|"']+/g)) {
    const id = linkedDriveFileId(match[0]);
    if (id) ids.add(id);
  }
  return [...ids];
}

function grantKey(scope: { sessionId: string; threadKey: string }, fileId: string): string {
  // Slack thread keys are unique per conversation. Site keys such as `web:default`
  // repeat across assistants, so the session id keeps those grants apart.
  if (SLACK_THREAD.test(scope.threadKey)) return JSON.stringify([scope.threadKey, fileId]);
  return JSON.stringify([scope.sessionId, scope.threadKey, fileId]);
}

/** Bind a team assistant thread after Slack routing, or after an authorized site prompt. */
export async function bindLinkedDriveThread(db: AppDb, args: {
  orgId: string;
  owner: Principal;
  sessionId: string;
  threadId: string;
  threadKey: string;
}): Promise<void> {
  if (args.owner.type !== "team") return;
  if (!SLACK_THREAD.test(args.threadKey) && !SITE_THREAD.test(args.threadKey)) return;
  await pluginStore(db, "valet").org(args.orgId).put(THREADS,
    JSON.stringify([args.owner.id, args.sessionId, args.threadId]), { threadKey: args.threadKey });
}

/**
 * Record links the member typed in the site chat. Call this before the prompt
 * is queued. Skill expansion is not scanned: pass the typed text.
 * A Slack-looking key is recorded only when Slack routing already bound that thread.
 */
export async function recordLinkedDrivePrompt(db: AppDb, args: {
  orgId: string;
  owner: Principal;
  sessionId: string;
  threadId: string;
  threadKey: string;
  purpose: string | undefined;
  text: string;
}): Promise<void> {
  if (args.owner.type !== "team" || args.purpose !== "orchestrator") return;
  const fileIds = linkedDriveFileIds(args.text);
  if (fileIds.length === 0) return;
  const store = pluginStore(db, "valet").org(args.orgId);
  if (SITE_THREAD.test(args.threadKey)) {
    await bindLinkedDriveThread(db, args);
    for (const fileId of fileIds) {
      await store.put(COLLECTION, grantKey(args, fileId), { source: "site" });
    }
    return;
  }
  if (!SLACK_THREAD.test(args.threadKey)) return;
  const binding = await store.get<unknown>(THREADS, JSON.stringify([args.owner.id, args.sessionId, args.threadId]));
  if (!record(binding?.doc) || binding.doc.threadKey !== args.threadKey) return;
  for (const fileId of fileIds) {
    await store.put(COLLECTION, grantKey(args, fileId), { source: "site" });
  }
}

export class GoogleWorkspaceLinkScope {
  constructor(private readonly deps: {
    db: AppDb;
    engineStore: Pick<SessionStore, "getSession" | "getThread">;
    getRun: WorkflowStore["getRun"];
  }) {}

  /** Call only after Slack signature and workspace checks, before dispatching the event. */
  async recordSlackMessage(orgId: string, raw: unknown): Promise<void> {
    if (!record(raw) || raw.type !== "event_callback" || !record(raw.event)) return;
    const event = raw.event;
    if ((event.type !== "message" && event.type !== "app_mention") || event.bot_id || event.bot_profile
      || event.app_id || event.subtype || typeof event.user !== "string" || !/^[UW][A-Z0-9]+$/.test(event.user)
      || typeof event.channel !== "string" || typeof event.ts !== "string" || typeof event.text !== "string") return;
    const threadTs = event.thread_ts ?? event.ts;
    if (typeof threadTs !== "string" || !/^\d+\.\d+$/.test(threadTs)) return;
    const threadKey = `slack:${event.channel}:${threadTs}`;
    const store = pluginStore(this.deps.db, "valet").org(orgId);
    for (const fileId of linkedDriveFileIds(event.text)) {
      await store.put(COLLECTION, JSON.stringify([threadKey, fileId]), { messageTs: event.ts });
    }
  }

  private async threadScope(ctx: PluginActionContext, teamId: string): Promise<{ sessionId: string; threadKey: string } | null> {
    let sessionId = ctx.sessionId;
    let threadId = ctx.threadId;
    if (ctx.sessionPurpose === "workflow") {
      // Both forms are host-minted: session nodes and headless tool invocations.
      const runId = sessionId.match(/^wf:invoke:workflow:([a-zA-Z0-9_-]+):/)?.[1]
        ?? sessionId.match(/^wf:([a-zA-Z0-9_-]+):[a-zA-Z0-9_-]+(?::\d+)?$/)?.[1];
      if (!runId) return null;
      const run = await this.deps.getRun(runId);
      if (!run || run.owner?.ownerType !== "team" || run.owner.ownerId !== teamId || !run.params.origin) return null;
      const [definition] = await this.deps.db.select({ id: workflowDefinitions.id }).from(workflowDefinitions)
        .where(and(eq(workflowDefinitions.id, run.params.workflowId), eq(workflowDefinitions.orgId, ctx.orgId),
          eq(workflowDefinitions.ownerType, "team"), eq(workflowDefinitions.ownerId, teamId))).limit(1);
      if (!definition) return null;
      sessionId = run.params.origin.assistantSessionId;
      threadId = run.params.origin.threadId;
    }
    const session = await this.deps.engineStore.getSession(sessionId);
    if (!session || session.orgId !== ctx.orgId || session.owner.type !== "team" || session.owner.id !== teamId
      || session.purpose !== "orchestrator") return null;
    const thread = await this.deps.engineStore.getThread(sessionId, threadId);
    if (!thread || thread.status === "archived") return null;
    const binding = await pluginStore(this.deps.db, "valet").org(ctx.orgId)
      .get<unknown>(THREADS, JSON.stringify([teamId, sessionId, threadId]));
    // A caller-created thread with a Slack-looking key must not acquire the channel's grants.
    if (!record(binding?.doc) || binding.doc.threadKey !== thread.key) return null;
    return { sessionId, threadKey: thread.key };
  }

  wrapPlugins(plugins: ValetPlugin[]): ValetPlugin[] {
    return plugins.map((plugin) => ({
      ...plugin,
      actions: plugin.actions?.map((actions) => {
        if ((actions.credentialService ?? actions.service) !== "google_workspace") return actions;
        const wrap = (action: PluginAction): PluginAction => ({
          ...action,
          execute: async (args, ctx) => {
            // All production dispatchers supply the owner. Missing ownership must not opt out.
            if (!ctx.owner) return { success: false, error: DENIED };
            if (ctx.owner.type !== "team") return action.execute(args, ctx);
            const field = actions.service === "google_workspace" && Object.hasOwn(TARGETS, action.id) ? TARGETS[action.id] : undefined;
            if (!field || !record(args) || typeof args[field] !== "string") return { success: false, error: DENIED };
            const target = args[field];
            const fileId = ID.test(target) ? target : linkedDriveFileId(target);
            if (!fileId) return { success: false, error: DENIED };
            try {
              const scope = await this.threadScope(ctx, ctx.owner.id);
              const grant = scope && await pluginStore(this.deps.db, "valet").org(ctx.orgId)
                .get(COLLECTION, grantKey(scope, fileId));
              if (!grant) return { success: false, error: DENIED };
            } catch {
              return { success: false, error: "Drive file scope is unavailable. Retry this action after the service recovers." };
            }
            // Send the checked ID, so downstream URL normalization cannot change the target.
            return action.execute({ ...args, [field]: fileId }, ctx);
          },
        });
        const resolveActions = actions.resolveActions;
        return {
          ...actions,
          actions: actions.actions?.map(wrap),
          ...(resolveActions ? { resolveActions: async (...args: Parameters<typeof resolveActions>) =>
            (await resolveActions(...args)).map(wrap) } : {}),
        };
      }),
    }));
  }
}
