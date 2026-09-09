import { useSyncExternalStore } from "react";
import type { ChangelogCheckpoint } from "@valet/api/wire";
import { safeLocalStorage, type StorageReader, type StorageWriter } from "./safe-storage";

const PREFIX = "valet:changelog-seen:";
const listeners = new Set<() => void>();

function key(userId: string): string {
  return `${PREFIX}${userId}`;
}

export function lastSeenCheckpoint(
  userId: string,
  storage: StorageReader = safeLocalStorage(),
): string | null {
  try {
    return storage.getItem(key(userId));
  } catch {
    return null;
  }
}

export function markChangelogSeen(
  userId: string,
  checkpointId: string,
  storage: StorageWriter = safeLocalStorage(),
): void {
  try {
    storage.setItem(key(userId), checkpointId);
    listeners.forEach((listener) => listener());
  } catch {
    /* The visible page is still read when browser storage is unavailable. */
  }
}

export function useLastSeenCheckpoint(userId: string | undefined): string | null {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => (userId ? lastSeenCheckpoint(userId) : null),
    () => null,
  );
}

export function unreadCheckpointIds(
  checkpoints: ChangelogCheckpoint[],
  seenId: string | null,
): Set<string> {
  if (checkpoints.length === 0 || seenId === checkpoints[0].id) return new Set();
  const seenIndex = seenId ? checkpoints.findIndex((checkpoint) => checkpoint.id === seenId) : -1;
  const unread = seenIndex === -1 ? checkpoints : checkpoints.slice(0, seenIndex);
  return new Set(unread.map((checkpoint) => checkpoint.id));
}
