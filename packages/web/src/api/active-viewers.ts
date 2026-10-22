/**
 * Who has a thread open right now. The open thread's list arrives on its
 * session socket (`thread.viewers`); the thread list reads the whole
 * workspace every 15 seconds (`GET /api/threads/viewers`).
 */
import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { create } from "zustand";
import type { ActiveViewer } from "@valet/api/wire";
import { api } from "./client";

const NO_VIEWERS: ActiveViewer[] = [];
/** How often the thread list asks who is where. */
const WORKSPACE_VIEWERS_POLL_MS = 15_000;

interface ActiveViewersState {
  /** Viewer lists by session, then thread. */
  bySession: Record<string, Record<string, ActiveViewer[]>>;
  set: (sessionId: string, threadId: string, viewers: ActiveViewer[]) => void;
  clear: (sessionId: string) => void;
}

export const useActiveViewersStore = create<ActiveViewersState>((set) => ({
  bySession: {},
  set: (sessionId, threadId, viewers) => set((state) => ({
    bySession: { ...state.bySession, [sessionId]: { ...state.bySession[sessionId], [threadId]: viewers } },
  })),
  clear: (sessionId) => set((state) => {
    if (!state.bySession[sessionId]) return state;
    const { [sessionId]: _cleared, ...rest } = state.bySession;
    return { bySession: rest };
  }),
}));

/** The other people with the thread open, the reader left out. */
export function useActiveViewers(sessionId: string, threadId: string | undefined, readerId: string | undefined): ActiveViewer[] {
  const viewers = useActiveViewersStore((state) => (threadId ? state.bySession[sessionId]?.[threadId] : undefined) ?? NO_VIEWERS);
  return useMemo(() => viewers.filter((viewer) => viewer.userId !== readerId), [viewers, readerId]);
}

/** Who is in each thread of a workspace ("user" or a team id), for the thread list. */
export function useWorkspaceViewers(workspace: string | undefined) {
  return useQuery({
    queryKey: ["active-viewers", workspace],
    queryFn: () => api.getActiveViewers(workspace ?? "user"),
    enabled: workspace !== undefined,
    refetchInterval: WORKSPACE_VIEWERS_POLL_MS,
  });
}
