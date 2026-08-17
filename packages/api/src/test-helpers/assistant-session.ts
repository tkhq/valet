/**
 * The default assistant session of a principal, for tests that address an
 * assistant by its owner.
 *
 * No second definition: this calls `ensureDefaultAssistantSession`
 * (`assistants/service.ts`), the same function every production caller
 * uses, and unwraps its result to the `Session` a test asserts on. It
 * exists because a principal no longer names a session — a test that wants
 * "this user's assistant session" must resolve the assistant first, exactly
 * as the routes do.
 */
import type { Principal, Session } from "@valet/engine";
import type { AppDb } from "../lib/drizzle.js";
import type { EngineHost } from "../engine/host.js";
import { ensureDefaultAssistantSession } from "../assistants/service.js";

export async function defaultAssistantSessionFor(
  providers: { db: AppDb; engineHost: EngineHost },
  principal: Principal,
  meta: { actorUserId: string; orgId: string },
): Promise<Session> {
  const { session } = await ensureDefaultAssistantSession(
    { db: providers.db, engineHost: providers.engineHost },
    principal,
    meta,
  );
  return session;
}
