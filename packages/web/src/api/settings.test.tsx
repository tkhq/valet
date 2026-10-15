// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import type { ReactNode } from "react";
import { renderHook } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type {
  CreateTeamRequest,
  CreateTeamResponse,
} from "@valet/api/wire";

const createTeam = vi.fn();
const patchMe = vi.fn();
const providerCall = vi.fn(async () => undefined);

vi.mock("./client", () => ({
  api: {
    createTeam: (body: CreateTeamRequest) => createTeam(body),
    patchMe: (body: unknown) => patchMe(body),
    createLlmProvider: () => providerCall(),
    patchLlmProvider: () => providerCall(),
    deleteLlmProvider: () => providerCall(),
    putLlmProviderKey: () => providerCall(),
    deleteLlmProviderKey: () => providerCall(),
  },
}));

import {
  qkSettings,
  teamCreateQueryKeys,
  useCreateLlmProvider,
  useCreateTeam,
  useDeleteLlmProvider,
  useDeleteLlmProviderKey,
  usePatchLlmProvider,
  usePatchMe,
  usePutLlmProviderKey,
} from "./settings";

const created: CreateTeamResponse = {
  team: {
    id: "team_1",
    orgId: "org_1",
    name: "Platform",
    origin: "local",
    externalId: null,
    createdAt: 1,
    memberCount: 1,
    callerRole: "admin",
    defaultModel: null,
  },
  runtime: { sessionId: "assistant:asst_team" },
};

function makeClient() {
  return new QueryClient({ defaultOptions: { queries: { retry: false } } });
}

function wrapperFor(client: QueryClient) {
  return function Wrapper({ children }: { children: ReactNode }) {
    return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
  };
}

describe("workspace creation", () => {
  it("invalidates the team list without an assistant-list cache", async () => {
    expect(teamCreateQueryKeys()).toEqual([qkSettings.teams()]);
    createTeam.mockResolvedValueOnce(created);
    const client = makeClient();
    const invalidate = vi.spyOn(client, "invalidateQueries");
    const { result } = renderHook(() => useCreateTeam(), { wrapper: wrapperFor(client) });
    await result.current.mutateAsync({ name: "Platform" });
    expect(invalidate).toHaveBeenCalledWith({ queryKey: qkSettings.teams() });
    expect(client.getQueryData(["assistants"])).toBeUndefined();
  });
});

describe("LLM provider mutations", () => {
  // The model tiers response says whether the org default tier can run, and
  // that answer depends on the providers and their keys.
  it("each provider and key change refreshes the model tiers", async () => {
    const client = makeClient();
    const invalidate = vi.spyOn(client, "invalidateQueries");
    const wrapper = wrapperFor(client);
    const mutations: Record<string, () => Promise<unknown>> = {
      create: () => renderHook(() => useCreateLlmProvider(), { wrapper }).result.current
        .mutateAsync({ kind: "openai", name: "OpenAI" }),
      patch: () => renderHook(() => usePatchLlmProvider(), { wrapper }).result.current
        .mutateAsync({ id: "p1", body: { enabled: false } }),
      delete: () => renderHook(() => useDeleteLlmProvider(), { wrapper }).result.current.mutateAsync("p1"),
      putKey: () => renderHook(() => usePutLlmProviderKey(), { wrapper }).result.current
        .mutateAsync({ id: "p1", body: { apiKey: "sk-test" } }),
      deleteKey: () => renderHook(() => useDeleteLlmProviderKey(), { wrapper }).result.current.mutateAsync("p1"),
    };
    for (const [name, run] of Object.entries(mutations)) {
      invalidate.mockClear();
      await run();
      expect(invalidate, name).toHaveBeenCalledWith({ queryKey: qkSettings.modelTiers() });
    }
  });
});

describe("usePatchMe timezone", () => {
  const me = {
    id: "u1", email: "a@b.c", name: "A", avatarUrl: null, role: "member", orgId: "o1", orgRole: "member",
    defaultModel: null, defaultReasoning: null, newThreadBehavior: "keep_current",
    timezone: "Europe/Paris", timezoneReportDone: false,
  } as const;

  it("marks the report done as soon as the user clears the timezone, before the server answers", async () => {
    let release: (value: unknown) => void = () => {};
    patchMe.mockReturnValueOnce(new Promise((resolve) => { release = resolve; }));
    const client = makeClient();
    client.setQueryData(qkSettings.me(), me);
    const { result } = renderHook(() => usePatchMe(), { wrapper: wrapperFor(client) });
    result.current.mutate({ timezone: null });
    await vi.waitFor(() => {
      expect(client.getQueryData(qkSettings.me())).toMatchObject({ timezone: null, timezoneReportDone: true });
    });
    release({ ...me, timezone: null, timezoneReportDone: true });
  });

  it("does not copy the browser report into the visible profile", async () => {
    patchMe.mockResolvedValueOnce({ ...me, timezone: "America/New_York", timezoneReportDone: true });
    const client = makeClient();
    client.setQueryData(qkSettings.me(), { ...me, timezone: null });
    const { result } = renderHook(() => usePatchMe(), { wrapper: wrapperFor(client) });
    result.current.mutate({ reportedTimezone: "America/New_York" });
    await vi.waitFor(() => expect(patchMe).toHaveBeenCalledWith({ reportedTimezone: "America/New_York" }));
    expect(client.getQueryData(qkSettings.me())).not.toHaveProperty("reportedTimezone");
  });
});
