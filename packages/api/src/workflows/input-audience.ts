import { and, eq, inArray, isNotNull } from "drizzle-orm";
import type { SessionStore } from "@valet/engine";
import type { AppDb } from "../lib/drizzle.js";
import { sessionThreads, userIdentityLinks } from "../schema/index.js";
import { isPersonalThreadKey, privateThreadOwner } from "../services/thread-access.js";
import { scopedInputRunStatus, type InputSandboxScope } from "./input-scope.js";

export const PERSONAL_INPUT_AUDIENCE_ERROR = "Workflow files cannot be delivered to a personal sandbox with another participant. Use a session step or archive the shared conversation.";

/** DMs use durable authors and linked identities. No generic membership table exists.
 * Without participant evidence, only non-DM channel keys count as shared. */
export async function personalInputAudienceIsShared(
  db: AppDb, store: SessionStore, sessionId: string, scope: InputSandboxScope,
): Promise<boolean> {
  const threads = await store.listThreads(sessionId, {
    keyPrefixes: ["slack:", "slack-events:", "telegram:", "github:", "app-assistant:", "workflow:"],
    excludeArchived: true,
  });
  if (!threads.length) return false;
  const archived = new Set((await db.select({ id: sessionThreads.id }).from(sessionThreads)
    .where(and(eq(sessionThreads.sessionId, sessionId), inArray(sessionThreads.id, threads.map(t => t.id)),
      isNotNull(sessionThreads.archivedAt)))).map(t => t.id));
  let identities: Map<string, string> | undefined;
  for (const thread of threads) {
    if (archived.has(thread.id)) continue;
    const runId = /:workflow:([A-Za-z0-9_-]+)$/.exec(thread.key)?.[1];
    if (runId && await scopedInputRunStatus(db, scope, runId) === "settled") continue;
    const participant = privateThreadOwner(thread.key);
    if (isPersonalThreadKey(thread.key)) {
      if (participant && participant !== scope.ownerId) return true;
      const authors = await store.listThreadAuthors(sessionId, thread.id);
      if (authors.some(author => author.id !== scope.ownerId || author.externalSender)) return true;
      continue;
    }
    const slack = /^(?:slack|slack-events):([^:]+)/.exec(thread.key);
    const telegram = /^telegram:(?:dm:)?([1-9][0-9]*)$/.exec(thread.key);
    // Slack D channels have exactly one human counterpart. G channels include group DMs.
    if (!(slack?.[1].startsWith("D") || telegram)) return true;
    identities ??= new Map((await db.select({ provider: userIdentityLinks.provider, externalId: userIdentityLinks.externalId })
      .from(userIdentityLinks).where(eq(userIdentityLinks.userId, scope.ownerId))).map(link => [link.provider, link.externalId]));
    const provider = telegram ? "telegram" : "slack";
    const ownIdentity = identities.get(provider);
    if (telegram && ownIdentity && telegram[1] !== ownIdentity) return true;
    const authors = await store.listThreadAuthors(sessionId, thread.id);
    if (authors.some(author => !(author.id === scope.ownerId && !author.externalSender) &&
        !(ownIdentity && author.externalId === ownIdentity))) return true;
  }
  return false;
}
