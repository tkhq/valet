// @vitest-environment jsdom
/**
 * `useEnsuredAssistantSession` — the one call that turns an assistant id
 * into a session the page may read.
 *
 * A team's default assistant is seeded as a row alone (no engine session),
 * so an id from the list can name a session that does not exist yet, and
 * every read of it 404s until this call creates it. Two components need
 * the answer — the chat page and the rail's thread tree — so the hook is a
 * query, keyed by assistant, and both share one POST.
 */
import { describe, expect, it, vi, beforeEach } from "vitest";
import type { ReactNode } from "react";
import { act, renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { EnsureAssistantSessionResponse, GetSessionResponse } from "@valet/api/wire";

const ASSISTANT_ID = "asst_1";
const SESSION = `assistant:${ASSISTANT_ID}`;

const ensureAssistantSession =
  vi.fn<(assistantId: string) => Promise<EnsureAssistantSessionResponse>>();
const getSession = vi.fn<(id: string) => Promise<GetSessionResponse>>();

vi.mock("~/api/client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("~/api/client")>();
  return {
    ...actual,
    api: {
      ...actual.api,
      ensureAssistantSession: (assistantId: string) => ensureAssistantSession(assistantId),
      getSession: (id: string) => getSession(id),
    },
  };
});

import { ApiError } from "~/api/client";
import { useSession } from "~/api/queries";
import { useEnsuredAssistantSession } from "./assistants";

function sessionRow(): GetSessionResponse {
  return {
    id: SESSION,
    title: "Triage",
    workspace: "acme/site",
    status: "active",
    kind: "code",
    runState: "idle",
    createdAt: 1,
    updatedAt: 1,
    lastActivityAt: 1,
    owner: { type: "team", id: "team_1" },
    messageCount: 0,
    profile: "headless",
    docker: false,
  };
}

function makeWrapper() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  );
}

let wrapper = makeWrapper();

beforeEach(() => {
  vi.clearAllMocks();
  wrapper = makeWrapper();
  ensureAssistantSession.mockResolvedValue({ sessionId: SESSION });
  getSession.mockResolvedValue(sessionRow());
});

describe("useEnsuredAssistantSession", () => {
  it("fires nothing without an id", () => {
    const { result } = renderHook(() => useEnsuredAssistantSession(undefined), { wrapper });
    expect(ensureAssistantSession).not.toHaveBeenCalled();
    expect(result.current.isSuccess).toBe(false);
  });

  it("shares one POST between every reader of the same assistant", async () => {
    const { result } = renderHook(
      () => [useEnsuredAssistantSession(ASSISTANT_ID), useEnsuredAssistantSession(ASSISTANT_ID)],
      { wrapper },
    );
    await waitFor(() => expect(result.current[0].isSuccess).toBe(true));
    expect(result.current[1].data).toEqual({ sessionId: SESSION });
    expect(ensureAssistantSession).toHaveBeenCalledTimes(1);
  });

  it("re-reads a session whose first read was in flight when the ensure answered", async () => {
    // The browser's order on a seeded assistant: a reader asks for the
    // session before the row exists, the ensure creates it while that read
    // is still out, and the read's 404 lands last. An invalidation on its
    // own does not recover this — a query with no data yet keeps its running
    // attempt — so the reader would keep the 404 until a reload.
    let rejectFirstRead: (() => void) | undefined;
    let resolveEnsure: (() => void) | undefined;
    getSession.mockImplementationOnce(
      () =>
        new Promise<GetSessionResponse>((_, reject) => {
          rejectFirstRead = () => reject(new ApiError(404, `GET /sessions/${SESSION} → 404`));
        }),
    );
    ensureAssistantSession.mockImplementationOnce(
      () =>
        new Promise<EnsureAssistantSessionResponse>((resolve) => {
          resolveEnsure = () => resolve({ sessionId: SESSION });
        }),
    );

    const reader = renderHook(() => useSession(SESSION), { wrapper });
    await waitFor(() => expect(getSession).toHaveBeenCalledTimes(1));
    const ensured = renderHook(() => useEnsuredAssistantSession(ASSISTANT_ID), { wrapper });
    await waitFor(() => expect(resolveEnsure).toBeDefined());

    await act(async () => {
      resolveEnsure?.();
    });
    await act(async () => {
      rejectFirstRead?.();
    });

    await waitFor(() => expect(ensured.result.current.isSuccess).toBe(true));
    await waitFor(() => expect(reader.result.current.data?.title).toBe("Triage"));
    expect(reader.result.current.error).toBeNull();
    expect(getSession).toHaveBeenCalledTimes(2);
  });
});
