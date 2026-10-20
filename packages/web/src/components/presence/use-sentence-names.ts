/**
 * The people a Presence sentence may name: the viewer, and every org member
 * by user id. A mention line created by someone else reads `When <name>
 * mentions Valet` (docs/specs/2026-10-16-presence-hub-design.md Part C step 2).
 * The member directory is readable by every member, unlike the admin roster.
 */
import { useOrgDirectory, useMe } from "~/api/settings";
import type { SentenceNames } from "./sentences";

export function useSentenceNames(): SentenceNames {
  const me = useMe();
  const directory = useOrgDirectory();
  const members: Record<string, string> = {};
  for (const user of directory.data?.users ?? []) {
    const name = user.name.trim() || user.email;
    if (name.length > 0) members[user.userId] = name;
  }
  return { members, ...(me.data?.id !== undefined ? { me: me.data.id } : {}) };
}
