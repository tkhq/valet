import type { Principal } from "@valet/engine";
import type { agentSessions } from "../schema/index.js";

/** A session's owner principal, from the app row. Legacy rows default
 * `owner_id` to "", so fall back to the creating user. */
export function sessionOwner(row: typeof agentSessions.$inferSelect): Principal {
  const type = row.ownerType === "team" || row.ownerType === "org" ? row.ownerType : "user";
  return { type, id: row.ownerId !== "" ? row.ownerId : row.userId };
}
