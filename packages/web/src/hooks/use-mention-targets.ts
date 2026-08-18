/**
 * The path set the composer's `@` popup completes over (V1 port #9).
 *
 * Both sources are already cached by other surfaces, so opening the popup
 * costs no request of its own in the common case, and neither reads a
 * sandbox. Changed files come first: in a session about a repository, the
 * files that session just touched are the ones being discussed.
 */
import { useMemo } from "react";
import { useFilesChanged } from "~/api/queries";
import { useMemoryTree } from "~/api/memory";
import type { MentionTarget } from "~/lib/mention-targets";

export const CHANGED_FILES_GROUP = "Changed files";
export const MEMORY_GROUP = "Memory";

/**
 * The completions, plus the state of the two fetches behind them.
 *
 * The caller needs the state, not only the list. Both sources start
 * disabled and turn on at the FIRST `@`, so an empty list means "still
 * loading" as often as it means "nothing to suggest", and a failed fetch
 * produces the same empty list as an empty result. Saying "this session has
 * no repository changes" in either case is a claim about the session that
 * the hook has not checked.
 */
export interface MentionTargets {
  targets: MentionTarget[];
  /** At least one source is still being read. */
  isLoading: boolean;
  /** At least one source failed, so the list is incomplete. */
  isError: boolean;
}

export function useMentionTargets(sessionId: string, enabled: boolean): MentionTargets {
  // `enabled` keeps a composer that nobody has typed `@` into from fetching
  // either list. Once the popup has opened, react-query holds the result and
  // later keystrokes read the cache.
  //
  // `refetchInterval: false` matters here: `useFilesChanged` polls every ten
  // seconds for the Activity drawer, and a keystroke must not start a poll.
  const changed = useFilesChanged(sessionId, {
    enabled: enabled && !!sessionId,
    refetchInterval: false,
  });
  const memory = useMemoryTree(undefined, { enabled });

  const targets = useMemo(() => {
    const list: MentionTarget[] = [];
    for (const file of changed.data?.files ?? []) {
      list.push({
        path: file.path,
        group: CHANGED_FILES_GROUP,
        detail: file.binary ? "binary" : `+${file.additions} -${file.deletions}`,
      });
    }
    for (const entry of memory.data?.entries ?? []) {
      // Directory rows name no document, so completing one would insert a
      // path the agent cannot read.
      if (entry.dir) continue;
      list.push({ path: entry.path, group: MEMORY_GROUP, detail: entry.title });
    }
    return list;
  }, [changed.data, memory.data]);

  return {
    targets,
    isLoading: changed.isLoading || memory.isLoading,
    isError: changed.isError || memory.isError,
  };
}
