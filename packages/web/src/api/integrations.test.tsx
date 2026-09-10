// @vitest-environment jsdom
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { api } from "./client";
import { qkIntegrations, useCredentials, useDisconnectCredential } from "./integrations";

function harness() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
  return { client, wrapper: ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  ) };
}

beforeEach(() => vi.restoreAllMocks());

describe("credential scope and mutation completion", () => {
  it("keeps personal, team A, and team B results in separate cache entries", async () => {
    const { wrapper, client } = harness();
    vi.spyOn(api, "listCredentials").mockImplementation(async (scope, teamId) => ({
      credentials: [{ service: teamId ?? scope ?? "user", type: "api_key", connectedAt: "2026-09-10" }],
    }));
    const { result, rerender } = renderHook(({ teamId }: { teamId?: string }) => (
      useCredentials(teamId ? "team" : "user", { teamId })
    ), { wrapper, initialProps: {} });
    await waitFor(() => expect(result.current.data?.credentials[0]?.service).toBe("user"));
    rerender({ teamId: "a" });
    expect(result.current.data).toBeUndefined();
    await waitFor(() => expect(result.current.data?.credentials[0]?.service).toBe("a"));
    rerender({ teamId: "b" });
    expect(result.current.data).toBeUndefined();
    await waitFor(() => expect(result.current.data?.credentials[0]?.service).toBe("b"));
    rerender({ teamId: undefined });
    expect(result.current.data?.credentials[0]?.service).toBe("user");
    expect(client.getQueryData(qkIntegrations.credentials("team", "a"))).toEqual({
      credentials: [{ service: "a", type: "api_key", connectedAt: "2026-09-10" }],
    });
  });

  it("invalidates the deleted team's key after unmount, without invalidating another workspace", async () => {
    const { wrapper, client } = harness();
    for (const key of [qkIntegrations.credentials(), qkIntegrations.credentials("team", "a"), qkIntegrations.credentials("team", "b"), qkIntegrations.plugins()]) {
      client.setQueryData(key, { credentials: [] });
    }
    let finish: (value: { ok: true }) => void = () => {};
    vi.spyOn(api, "deleteCredential").mockReturnValue(new Promise((resolve) => { finish = resolve; }));
    const { result, unmount } = renderHook(() => useDisconnectCredential(), { wrapper });
    act(() => result.current.mutate({ service: "linear", scope: "team", teamId: "a" }));
    await waitFor(() => expect(api.deleteCredential).toHaveBeenCalledWith("linear", { scope: "team", teamId: "a" }));
    unmount();
    await act(async () => finish({ ok: true }));
    await waitFor(() => expect(client.getQueryState(qkIntegrations.credentials("team", "a"))?.isInvalidated).toBe(true));
    expect(client.getQueryState(qkIntegrations.credentials("team", "b"))?.isInvalidated).toBe(false);
    expect(client.getQueryState(qkIntegrations.credentials())?.isInvalidated).toBe(false);
    expect(client.getQueryState(qkIntegrations.plugins())?.isInvalidated).toBe(false);
  });

  it("keeps personal disconnect invalidation broad because team shares follow the source", async () => {
    const { wrapper, client } = harness();
    client.setQueryData(qkIntegrations.credentials("team", "a"), { credentials: [] });
    vi.spyOn(api, "deleteCredential").mockResolvedValue({ ok: true });
    const { result } = renderHook(() => useDisconnectCredential(), { wrapper });
    await act(async () => { await result.current.mutateAsync({ service: "linear" }); });
    expect(api.deleteCredential).toHaveBeenCalledWith("linear", undefined);
    expect(client.getQueryState(qkIntegrations.credentials("team", "a"))?.isInvalidated).toBe(true);
  });
});
