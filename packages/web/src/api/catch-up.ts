import type { OwnerFilter } from "./client";

export const qkCatchUp = {
  workArtifacts: (owner: OwnerFilter, sessionId: string, threadId?: string) =>
    ["artifacts", "work", owner.ownerType, owner.ownerId, sessionId, threadId] as const,
};
