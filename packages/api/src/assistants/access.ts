/**
 * Who may read and who may administer an assistant.
 *
 * No new scheme. An assistant's session already inherits `canViewSession` /
 * `canAdministerSession` through its `owner_type`/`owner_id`
 * (`services/session-access.ts`), so the assistant ROW answers the same two
 * questions with the same two functions. Multiplying assistants therefore
 * adds no authorization surface — see
 * `docs/specs/2026-08-13-assistants-design.md`, "Access".
 *
 * The adapter below is the whole trick: it presents an assistant row as the
 * `SessionOwnerLike` those functions take. `userId` is the direct owner a
 * user-owned assistant has, and the synthetic `{type}:{id}` a team- or
 * org-owned one has — the same synthetic id `workflows/engine-deps.ts`
 * stamps for a non-user principal, so the direct-owner comparison inside
 * `canViewSession` can never match a real user by accident.
 *
 * Consequence for org-owned assistants: neither check admits anybody, which
 * is exactly the limit `canViewSession` already has for org-owned sessions.
 * An org assistant is therefore not reachable through these routes until an
 * org-level rule exists to add. That is a deliberate hold, not an oversight.
 */
import type { Principal } from "@valet/engine";
import type { AppDb } from "../lib/drizzle.js";
import type { AssistantRow } from "../schema/index.js";
import { canAdministerSession, canViewSession, type SessionOwnerLike } from "../services/session-access.js";

/** The owner of an assistant, in the shape the session checks read. */
function ownerLike(principal: Principal): SessionOwnerLike {
  return {
    userId: principal.type === "user" ? principal.id : `${principal.type}:${principal.id}`,
    ownerType: principal.type,
    ownerId: principal.id,
  };
}

/** May `callerId` read this assistant and prompt its session? */
export function canViewAssistantOwner(db: AppDb, owner: Principal, callerId: string): Promise<boolean> {
  return canViewSession(db, ownerLike(owner), callerId);
}

/** May `callerId` create, rename, promote or archive assistants for this owner? */
export function canAdministerAssistantOwner(db: AppDb, owner: Principal, callerId: string): Promise<boolean> {
  return canAdministerSession(db, ownerLike(owner), callerId);
}

/** The owner principal of a stored assistant. */
export function assistantOwner(row: AssistantRow): Principal {
  return { type: row.ownerType, id: row.ownerId };
}
