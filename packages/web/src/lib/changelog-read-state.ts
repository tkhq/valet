import { useSyncExternalStore } from "react";
import type { ChangelogCheckpoint, ChangelogEntry } from "@valet/api/wire";
import { compareChangelogEntries } from "./changelog-view";
import { safeLocalStorage, type StorageReader, type StorageWriter } from "./safe-storage";

const PREFIX = "valet:changelog-seen:";
const listeners = new Set<() => void>();

export interface ChangelogReadState {
  /** Null is a fail-closed state for invalid persisted data. */
  checkpointId: string | null;
  /** Null preserves the old checkpoint-only storage format. */
  unreleasedEntryCommitShas: string[] | null;
}

function key(userId: string): string {
  return `${PREFIX}${userId}`;
}

function parseReadState(value: string | null): ChangelogReadState | null {
  if (value === null) return null;
  try {
    const parsed: unknown = JSON.parse(value);
    if (
      typeof parsed === "object"
      && parsed !== null
      && "checkpointId" in parsed
      && typeof parsed.checkpointId === "string"
      && "unreleasedEntryCommitShas" in parsed
      && Array.isArray(parsed.unreleasedEntryCommitShas)
      && parsed.unreleasedEntryCommitShas.every((sha) => typeof sha === "string")
    ) {
      return {
        checkpointId: parsed.checkpointId,
        unreleasedEntryCommitShas: parsed.unreleasedEntryCommitShas,
      };
    }
    return { checkpointId: null, unreleasedEntryCommitShas: null };
  } catch {
    // Only a non-JSON checkpoint id can use the legacy checkpoint-only format.
    if (/^[^\s@]+@[^\s@]+$/.test(value)) {
      return { checkpointId: value, unreleasedEntryCommitShas: null };
    }
    return { checkpointId: null, unreleasedEntryCommitShas: null };
  }
}

export function lastSeenChangelogState(
  userId: string,
  storage: StorageReader = safeLocalStorage(),
): ChangelogReadState | null {
  try {
    return parseReadState(storage.getItem(key(userId)));
  } catch {
    return null;
  }
}

export function lastSeenCheckpoint(
  userId: string,
  storage: StorageReader = safeLocalStorage(),
): string | null {
  return lastSeenChangelogState(userId, storage)?.checkpointId ?? null;
}

export function markChangelogSeen(
  userId: string,
  checkpointId: string,
  checkpoints: ChangelogCheckpoint[],
  storage: StorageWriter = safeLocalStorage(),
): void {
  const unreleased = checkpoints.find((checkpoint) => checkpoint.kind === "unreleased");
  const state: ChangelogReadState = {
    checkpointId,
    unreleasedEntryCommitShas: unreleased?.entries.map((entry) => entry.sources.commitSha) ?? [],
  };
  try {
    storage.setItem(key(userId), JSON.stringify(state));
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
  let seenIndex = seenId ? checkpoints.findIndex((checkpoint) => checkpoint.id === seenId) : -1;
  if (seenIndex === -1 && seenId?.startsWith("unreleased@")) {
    const seenSha = seenId.slice("unreleased@".length);
    seenIndex = checkpoints.findIndex(
      (checkpoint) => checkpoint.kind === "released" && checkpoint.releasedSha === seenSha,
    );
    if (seenIndex === -1 && checkpoints[0]?.kind === "unreleased") return new Set([checkpoints[0].id]);
  }
  const unread = seenIndex === -1 ? checkpoints : checkpoints.slice(0, seenIndex);
  return new Set(unread.map((checkpoint) => checkpoint.id));
}

function matchingSha(left: string, right: string): boolean {
  return left.startsWith(right) || right.startsWith(left);
}

function legacyUnreadCommitShas(checkpoint: ChangelogCheckpoint, checkpointId: string): Set<string> | null {
  if (checkpoint.kind !== "unreleased") return null;
  const seenSha = checkpointId.slice("unreleased@".length);
  const entries = [...checkpoint.entries].sort(compareChangelogEntries);
  const seenIndex = entries.findIndex((entry) => matchingSha(entry.sources.commitSha, seenSha));
  return seenIndex === -1 ? null : new Set(entries.slice(0, seenIndex).map((entry) => entry.sources.commitSha));
}

export function isUnreadChangelogEntry(
  checkpoint: ChangelogCheckpoint,
  entry: ChangelogEntry,
  unreadCheckpoints: Set<string>,
  seenState: ChangelogReadState | null,
): boolean {
  if (checkpoint.kind === "unreleased" && seenState?.checkpointId?.startsWith("unreleased@")) {
    if (seenState.unreleasedEntryCommitShas !== null) {
      return !seenState.unreleasedEntryCommitShas.includes(entry.sources.commitSha);
    }
    return legacyUnreadCommitShas(checkpoint, seenState.checkpointId)?.has(entry.sources.commitSha) ?? false;
  }
  return unreadCheckpoints.has(checkpoint.id);
}
