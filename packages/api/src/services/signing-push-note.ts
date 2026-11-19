/**
 * Sign by default (`docs/specs/2026-11-17-commit-signing-user-registered-keys-design.md`).
 *
 * After a successful `git push` in `bash`, the engine asks for a note to add
 * to the result. The note is where the agent decides what to do next, so the
 * guidance sits here and not only in the skill. It depends on the person who
 * asked for the work:
 *
 * - They set up passkey signing: sign the pushed commits, then push again.
 * - They did not: the commits stay unsigned; tell them about setup once per session.
 * - No person waits on the turn, or a team or channel sender runs it: no note.
 */
import type { GitPushFacts, GitPushTurn } from "@valet/engine";
import { loadTurnkeyConfig } from "@valet/plugin-turnkey/config";
import { COLLECTIONS, DEFAULT_KEY, PLUGIN_NAME, type EnrollmentDoc, type SigningHistoryDoc } from "@valet/plugin-turnkey/store";
import type { AppQueryable } from "../lib/drizzle.js";
import { pluginStore } from "./plugin-store.js";

export function signRequestNote(push: GitPushFacts): string {
  const repo = push.repo ?? "owner/name";
  const branch = push.branch ?? "my-branch";
  return [
    "[Valet] Next step: sign these commits before you open a pull request or reply.",
    "The person who asked set up commit signing, and the commits you pushed are unsigned. Run:",
    `1. call_tool turnkey.sign_commits params={"repo":"${repo}","branch":"${branch}","base":"origin/<base branch>"}`,
    `2. git push --force-with-lease origin ${branch}`,
    "Skip this only if the person said not to sign, or rejected a signing card for this branch.",
  ].join("\n");
}

export function setupNote(publicUrl: string | undefined): string {
  const where = publicUrl ? `under Commit signing in Integrations: ${publicUrl.replace(/\/+$/, "")}/integrations` : "under Commit signing in Integrations";
  return [
    "[Valet] These commits stay unsigned: the person who asked has not set up commit signing. Do not call turnkey.sign_commits.",
    `In your reply, tell the person once that they can set it up ${where}.`,
  ].join("\n");
}

/** The commits on this branch were signed in this session, and the push sent the signed head. */
async function alreadySigned(db: AppQueryable, turn: GitPushTurn, push: GitPushFacts): Promise<boolean> {
  if (!push.branch) return false;
  const { items } = await pluginStore(db, PLUGIN_NAME)
    .user(turn.userId)
    .list<SigningHistoryDoc>(COLLECTIONS.signingHistory, { prefix: `${turn.sessionId}:`, limit: 200 });
  return items.some(({ doc }) => {
    if (doc.branch !== push.branch || (push.repo && doc.repo.toLowerCase() !== push.repo.toLowerCase())) return false;
    const head = doc.commits[doc.commits.length - 1]?.new;
    return !push.headSha || (head !== undefined && head.startsWith(push.headSha));
  });
}

export function signingPushNote(db: AppQueryable, publicUrl: string | undefined, env: Record<string, string | undefined> = process.env) {
  return async (push: GitPushFacts, turn: GitPushTurn): Promise<string | undefined> => {
    if (!loadTurnkeyConfig(env)) return undefined;
    if (turn.unattended || turn.externalSender || /^(team|org):/.test(turn.userId)) return undefined;
    const enrollment = (await pluginStore(db, PLUGIN_NAME).user(turn.userId).get<EnrollmentDoc>(COLLECTIONS.enrollment, DEFAULT_KEY))?.doc;
    if (enrollment?.signingKey) {
      if (enrollment.mode === "session") return undefined;
      return (await alreadySigned(db, turn, push)) ? undefined : signRequestNote(push);
    }
    const notes = pluginStore(db, PLUGIN_NAME).session(turn.sessionId);
    const key = `setup:${turn.userId}`;
    if (await notes.get(COLLECTIONS.pushNotes, key)) return undefined;
    await notes.put(COLLECTIONS.pushNotes, key, { at: Date.now() });
    return setupNote(publicUrl);
  };
}
