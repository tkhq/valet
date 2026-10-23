/** The thread sidebar: 200 threads with long titles, every origin, pull
 * requests, shares, questions, unread dots, and many children under a few
 * threads. */
import type {
  ArtifactListItem, ChildWorkResponse, DecisionGate, ListArtifactsResponse, ListDecisionsResponse, ListSessionWakeupsResponse,
  ListThreadsResponse, ListWorkflowsResponse, ThreadSummary, WorkflowDefinitionSummary,
} from "@valet/api/wire";
import { threadOriginBucket, type ThreadOriginBucket } from "~/lib/thread-origin";
import { EMOJI, HEX_300, HOUR, MINUTE, NOW, RTL_HEBREW, TITLE_400, stressMe, unbroken } from "./common";
import { decisionGate, stressTitle } from "./approvals";

/** The workspace session the rail lists, for every workspace key. */
export const SIDEBAR_SESSION_ID = "session-sidebar-stress";

export const SIDEBAR_THREAD_COUNT = 200;
export const SIDEBAR_PAGE_SIZE = 50;

const KEYS: Array<string | undefined> = [
  undefined,
  "web:chat-1",
  "events",
  `signal:workflow:wfrun_${unbroken("abc", 30)}`,
  "slack:C0123456789:1712345678.000100",
  "telegram:123456",
  `signal:${unbroken("sender", 30)}`,
];

function threadTitle(i: number): string | undefined {
  if (i % 17 === 5) return undefined;
  if (i % 11 === 0) return TITLE_400;
  if (i % 13 === 0) return `${RTL_HEBREW} ${EMOJI}`;
  return stressTitle(i);
}

function thread(i: number): ThreadSummary {
  const lastUserActivityAt = NOW - i * 23 * MINUTE;
  return {
    id: `sidebar-thread-${i}`,
    sessionId: SIDEBAR_SESSION_ID,
    title: threadTitle(i),
    createdAt: lastUserActivityAt - HOUR,
    lastUserActivityAt,
    // Thread 0 is the default row; it starts read, so mount does not mark it.
    lastAgentActivityAt: i === 0 ? undefined : i % 3 === 0 ? lastUserActivityAt + MINUTE : lastUserActivityAt - MINUTE,
    readAt: i === 0 || i % 6 === 0 ? undefined : lastUserActivityAt,
    key: KEYS[i % KEYS.length],
    model: i % 9 === 0 ? `openrouter/${unbroken("provider-preview-model-", 50)}` : undefined,
    agentQuestion: i % 10 === 3 ? TITLE_400 : undefined,
    share: i % 15 === 0 ? "reply" : i % 15 === 7 ? "view" : undefined,
    channel: i % 7 === 4 ? { key: KEYS[4]!, provider: "slack", conversationUrl: `https://example.slack.com/archives/${unbroken("C0123", 200)}` } : undefined,
    pullRequests: i % 8 === 2 ? Array.from({ length: 4 }, (_, n) => ({
      url: `https://github.com/example/${unbroken("repository-name-", 80)}/pull/${n + 100}`,
      repo: `example/${unbroken("repository-name-", 80)}`,
      number: n + 100_000_000,
      state: (["open", "merged", "closed"] as const)[n % 3]!,
    })) : undefined,
  };
}

export const stressSidebarThreads: ThreadSummary[] = Array.from({ length: SIDEBAR_THREAD_COUNT }, (_, i) => thread(i));

/** One page of the rail's list for a sort, an origin filter, and a cursor. */
export function sidebarThreadPage(origin: string, cursor: string | undefined): ListThreadsResponse {
  const matching = origin === "all" ? stressSidebarThreads
    : stressSidebarThreads.filter((t) => threadOriginBucket(t) === origin);
  const index = cursor ? Number(cursor.replace("threads-page-", "")) : 0;
  const start = index * SIDEBAR_PAGE_SIZE;
  const end = start + SIDEBAR_PAGE_SIZE;
  const counts: Record<ThreadOriginBucket, number> = { all: stressSidebarThreads.length, chat: 0, auto: 0, channel: 0, other: 0 };
  for (const t of stressSidebarThreads) counts[threadOriginBucket(t)] += 1;
  return {
    threads: matching.slice(start, end),
    nextCursor: end < matching.length ? `threads-page-${index + 1}` : undefined,
    defaultThreadId: index === 0 ? stressSidebarThreads[0]!.id : undefined,
    originCounts: counts,
  };
}

/** Threads that match a search, as the search dialog reads them. */
export function searchSidebarThreads(query: string): ListThreadsResponse {
  const q = query.toLowerCase();
  return { threads: stressSidebarThreads.filter((t) => (t.title ?? "").toLowerCase().includes(q)) };
}

/** Threads by id, for pinned rows and rows with a pending gate. */
export function fixedSidebarThreads(ids: readonly unknown[], threadId: unknown): ListThreadsResponse {
  return { threads: stressSidebarThreads.filter((t) => ids.includes(t.id) || t.id === threadId) };
}

export const stressArchivedThreads: ListThreadsResponse = {
  threads: Array.from({ length: 20 }, (_, i) => ({ ...thread(i + 300), id: `archived-thread-${i}`, archivedAt: NOW - i * HOUR })),
};

/** Pending gates on a few threads, so their rows show the approval icon. */
export const stressSidebarDecisions: ListDecisionsResponse = {
  gates: [3, 10, 42, 120].map((n, i): DecisionGate => decisionGate(i, {
    id: `sidebar-gate-${n}`,
    sessionId: SIDEBAR_SESSION_ID,
    threadId: `sidebar-thread-${n}`,
    status: "pending",
  })),
};

/** Sub-conversations: 40 under one thread, a few under others. */
export const stressChildWork: ChildWorkResponse = {
  runningCount: 37,
  nextCursor: null,
  children: Array.from({ length: 60 }, (_, i) => ({
    sessionId: `child-session-${i}`,
    title: i % 4 === 0 ? TITLE_400 : i % 4 === 1 ? `${unbroken("subtask", 120)}-${i}` : stressTitle(i),
    parentThreadId: i < 40 ? "sidebar-thread-1" : `sidebar-thread-${(i % 5) * 2 + 2}`,
    status: i % 3 === 0 ? "settled" : "running",
    outcome: i % 3 === 0 ? (i % 2 === 0 ? `failed: ${HEX_300}` : "completed") : undefined,
    createdAt: NOW - i * MINUTE,
  })),
};

/** The search dialog's Workflows group: long names, read while it is open. */
export const stressSearchWorkflows: ListWorkflowsResponse = {
  workflows: Array.from({ length: 12 }, (_, i): WorkflowDefinitionSummary => ({
    id: `search-workflow-${i}`,
    name: i % 4 === 0 ? TITLE_400 : stressTitle(i),
    definition: {},
    createdAt: NOW - i * HOUR,
    updatedAt: NOW - i * MINUTE,
    ownerType: "user",
    ownerId: stressMe.id,
  })),
};

/** The search dialog's Files group: long titles, unbroken paths, and one revoked file it leaves out. */
export const stressSearchArtifacts: ListArtifactsResponse = {
  artifacts: Array.from({ length: 12 }, (_, i): ArtifactListItem => ({
    id: `search-artifact-${i}`,
    ownerType: "user",
    path: i % 3 === 0 ? `reports/${unbroken("quarterly-", 40)}.md` : `journal/2026-10-${String(i + 1).padStart(2, "0")}.md`,
    title: i % 4 === 1 ? TITLE_400 : stressTitle(i),
    format: i % 2 === 0 ? "markdown" : "html",
    icon: "file",
    version: i + 1,
    sharedVersion: null,
    token: `search-artifact-token-${i}`,
    url: `https://valet.example/a/search-artifact-token-${i}`,
    visibility: "org",
    actorUserId: stressMe.id,
    revoked: i === 11,
    createdAt: NOW - i * HOUR,
    updatedAt: NOW - i * MINUTE,
  })),
};

/** Background work in the sidebar session: timers give rows 1 and 11 (a
 * 400-character title) the wait line, and a process and a hold on row 2
 * give it none. */
export const stressSidebarWakeups: ListSessionWakeupsResponse = {
  wakeups: [
    { id: "wk_stress_1", threadId: "sidebar-thread-1", kind: "timer", status: "pending", reason: TITLE_400, fireAt: NOW + 26 * MINUTE, createdAt: NOW },
    { id: "wk_stress_11", threadId: "sidebar-thread-11", kind: "timer", status: "pending", reason: "check CI", fireAt: NOW + 47 * HOUR, createdAt: NOW },
    { id: "wk_stress_2", threadId: "sidebar-thread-2", kind: "process", status: "running", reason: "full proof build", deadlineAt: NOW + 30 * HOUR, createdAt: NOW - HOUR },
  ],
  leases: [
    { id: "ls_stress_2", threadId: "sidebar-thread-2", ownerKind: "hold", reason: "terminal work", deadlineAt: NOW + 3 * HOUR, createdAt: NOW },
  ],
};
