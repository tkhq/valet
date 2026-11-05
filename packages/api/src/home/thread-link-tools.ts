/**
 * Tools that let two threads a fork links talk to each other
 * (docs/specs/2026-10-22-thread-edit-fork-design.md): a private
 * fork reports back to the team thread it came from, and a team thread
 * hands a question to a fork.
 *
 * A message carries this thread's content to the other thread's readers. When
 * one of them cannot read this thread (`sendWidens`), the person who wrote
 * this turn approves the exact text first. The sender must read the target,
 * and only a turn a person wrote may send, never a signal or a routine.
 */
import { createHash } from "node:crypto";
import { eq } from "drizzle-orm";
import { Type, type TSchema } from "typebox";
import type { ToolContext, ToolDef } from "@valet/engine";
import { sessionThreads } from "../schema/index.js";
import { linkedThreads, sendWidens, threadOwner, threadReaders, userCanReadThread, workspaceName, type LinkedThread } from "../services/thread-links.js";
import { sessionFor, userDisplayName, type HomeDeps } from "./service.js";

function defineTool<T extends TSchema>(def: ToolDef<T>): ToolDef<T> {
  return def;
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** This thread, its workspace, its readers, and the threads a fork links to it. */
async function linksOf(deps: HomeDeps, ctx: ToolContext) {
  const thread = await deps.engineStore.getThread(ctx.sessionId, ctx.threadId);
  const owner = await threadOwner(deps.db, ctx.sessionId);
  if (!thread || !owner) return undefined;
  const at = { sessionId: ctx.sessionId, threadId: ctx.threadId };
  return { thread, owner, at, readers: await threadReaders(deps.db, owner, at), links: await linkedThreads(deps.db, thread) };
}

export function buildThreadLinkTools(getDeps: () => HomeDeps): ToolDef[] {
  const listLinked = defineTool({
    name: "list_linked_threads",
    ownerOnly: true,
    concurrencySafe: true,
    description:
      "List the threads linked to this one by a branch: the thread this one was branched from, and the branches made from it. " +
      "For each, says whether a message from here goes straight there or asks the person first, because it would show this thread's content to people who cannot read it.",
    parameters: Type.Object({}),
    execute: async (_args, ctx) => {
      const deps = getDeps();
      try {
        const self = await linksOf(deps, ctx);
        if (!self || self.links.length === 0) return { text: "No linked threads. A thread links to another when one is a branch of the other." };
        const lines = await Promise.all(self.links.map(async (link) => {
          const where = await workspaceName(deps.db, link.owner, ctx.interactiveActor?.id);
          const send = await sendWidens(deps, self, await threadReaders(deps.db, link.owner, link)) ? "message_linked_thread shows the person the text to approve (do not ask first)" : "a message goes straight there";
          return `- ${link.threadId} (${link.relation === "source" ? "this thread was branched from it" : "a branch of this thread"}): "${link.title ?? "Untitled"}" in ${where}; ${send}.`;
        }));
        return { text: lines.join("\n") };
      } catch (err) {
        return { text: `[list_linked_threads_error] ${errorText(err)}`, ok: false };
      }
    },
  });

  const messageLinked = defineTool({
    name: "message_linked_thread",
    ownerOnly: true,
    description:
      "Send a message into a linked thread (from list_linked_threads), as the person who wrote this turn. Use it to report findings back to the thread this one was branched from, or to hand a question to a branch. " +
      "The other thread's assistant answers there. Write what that thread needs on its own: it cannot read this thread. " +
      "When the message would show this thread's content to people who cannot read it, this tool shows the person the exact text to approve. Do not call ask_approval first: that asks twice.",
    parameters: Type.Object({
      thread_id: Type.String({ description: "The linked thread's id." }),
      text: Type.String({ minLength: 1, maxLength: 20_000 }),
    }),
    execute: async (args, ctx) => {
      const actor = ctx.interactiveActor?.id;
      if (!actor || ctx.externalSender) {
        return { text: "[message_linked_thread_refused] Only a message a person writes can send into another thread. Ask them to confirm in their own message.", ok: false };
      }
      const deps = getDeps();
      try {
        const self = await linksOf(deps, ctx);
        const link: LinkedThread | undefined = self?.links.find((candidate) => candidate.threadId === args.thread_id);
        if (!self || !link) return { text: "[message_linked_thread_error] That thread is not linked to this one. Call list_linked_threads.", ok: false };
        if (!await userCanReadThread(deps, { id: actor, orgId: self.owner.orgId }, link.owner, link)) {
          return { text: "[message_linked_thread_refused] The person cannot read that thread, so they cannot post into it.", ok: false };
        }
        const where = await workspaceName(deps.db, link.owner, actor);
        if (await sendWidens(deps, self, await threadReaders(deps.db, link.owner, link))) {
          const decision = await ctx.requestDecision({
            type: "approval",
            title: `Post this to "${link.title ?? "Untitled"}" in ${where}?`,
            body: `People there who cannot read this thread will see this message:\n\n${args.text}`,
            actions: [{ id: "approve", label: "Post", style: "primary" }, { id: "cancel", label: "Don't post" }],
            resumeKey: `thread-link:${link.threadId}:${createHash("sha256").update(args.text).digest("hex").slice(0, 16)}`,
            context: { approver: { userId: actor } },
          });
          if (decision.actionId !== "approve" || decision.resolvedBy !== actor) {
            return { text: "The person did not approve the message, so nothing was posted." };
          }
        }
        const session = await sessionFor(deps, { ownerType: link.owner.ownerType, ownerId: link.owner.ownerId, sessionId: link.sessionId, orgId: link.owner.orgId, userId: actor });
        const target = await session.threadById(link.threadId);
        if (!target) return { text: "[message_linked_thread_error] The linked thread no longer exists.", ok: false };
        const [titled] = await deps.db.select({ title: sessionThreads.title }).from(sessionThreads).where(eq(sessionThreads.id, ctx.threadId)).limit(1);
        const title = titled?.title;
        const name = await userDisplayName(deps.db, actor);
        await target.submitPrompt(`[From the linked thread "${title ?? "Untitled"}"]\n\n${args.text}`, { author: { id: actor, ...(name ? { name } : {}) } });
        return { text: JSON.stringify({ threadId: link.threadId, workspace: where, note: "Sent. Its assistant answers there." }) };
      } catch (err) {
        return { text: `[message_linked_thread_error] ${errorText(err)}`, ok: false };
      }
    },
  });

  return [listLinked, messageLinked];
}
