// @vitest-environment jsdom
/**
 * `useSetMyToolModes`: the Integrations tool controls change at once, and a
 * refused write puts the previous value back.
 */
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ListToolPermissionsResponse, PutPolicyOverrideResponse } from "@valet/api/wire";
import { api } from "./client";
import { qkPolicies, useSetMyToolModes } from "./policies";

const TOOLS: ListToolPermissionsResponse = {
  tools: [{
    service: "github", actionId: "github.get_issue", name: "Get issue", description: "Reads an issue.",
    riskLevel: "low", mode: "allow", source: "default", overridden: false, settable: ["allow", "require_approval", "deny"],
  }],
};

const OVERRIDE: PutPolicyOverrideResponse = {
  id: "o1", service: null, actionId: "github.get_issue", riskLevel: null, mode: "deny", paramMatchers: [], createdAt: 1, updatedAt: 1,
};

function harness() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
  client.setQueryData(qkPolicies.myTools(), TOOLS);
  return { client, wrapper: ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  ) };
}

beforeEach(() => vi.restoreAllMocks());

describe("useSetMyToolModes", () => {
  it("shows the new value before the write settles", async () => {
    const { client, wrapper } = harness();
    let finish: (value: PutPolicyOverrideResponse) => void = () => {};
    vi.spyOn(api, "putMyPolicyOverride").mockReturnValue(new Promise((resolve) => { finish = resolve; }));
    vi.spyOn(api, "listMyToolPermissions").mockResolvedValue(TOOLS);
    const { result } = renderHook(() => useSetMyToolModes(), { wrapper });
    act(() => result.current.mutate({ actionIds: ["github.get_issue"], mode: "deny" }));
    await waitFor(() => expect(client.getQueryData<ListToolPermissionsResponse>(qkPolicies.myTools())?.tools[0])
      .toMatchObject({ mode: "deny", source: "personal", overridden: true }));
    expect(api.putMyPolicyOverride).toHaveBeenCalledWith({ actionId: "github.get_issue", mode: "deny" });
    await act(async () => finish(OVERRIDE));
  });

  it("rolls back when the write fails", async () => {
    const { client, wrapper } = harness();
    vi.spyOn(api, "putMyPolicyOverride").mockRejectedValue(new Error("refused"));
    vi.spyOn(api, "listMyToolPermissions").mockReturnValue(new Promise(() => {}));
    const { result } = renderHook(() => useSetMyToolModes(), { wrapper });
    act(() => result.current.mutate({ actionIds: ["github.get_issue"], mode: "deny" }));
    await waitFor(() => expect(result.current.error?.message).toBe("refused"));
    expect(client.getQueryData<ListToolPermissionsResponse>(qkPolicies.myTools())?.tools[0]).toMatchObject({ mode: "allow", source: "default" });
  });
});
