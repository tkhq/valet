// @vitest-environment jsdom
import type { ReactNode } from "react";
import { afterEach, expect, it, vi } from "vitest";
import { act, renderHook } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { api } from "./client";
import { qkTemplates } from "./templates";
import { useDeleteGithubApp, useRefreshGithubApp, useSaveGithubAppCredential } from "./settings";

afterEach(() => vi.restoreAllMocks());

it.each(["save", "refresh", "delete"])("invalidates every workspace's template prerequisites on GitHub App %s", async (operation) => {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
  const wrapper = ({ children }: { children: ReactNode }) => <QueryClientProvider client={client}>{children}</QueryClientProvider>;
  for (const team of [undefined, "a", "b"]) client.setQueryData(qkTemplates.list(team), { templates: [] });
  const status = { configured: true, installations: [], webhook: { mode: "manual" as const }, installationsCheckedAt: null };
  vi.spyOn(api, "postGithubAppCredential").mockResolvedValue(status);
  vi.spyOn(api, "refreshGithubApp").mockResolvedValue(status);
  vi.spyOn(api, "deleteGithubApp").mockResolvedValue(undefined);
  const { result } = renderHook(() => ({
    save: useSaveGithubAppCredential(), refresh: useRefreshGithubApp(), remove: useDeleteGithubApp(),
  }), { wrapper });
  await act(async () => {
    if (operation === "save") await result.current.save.mutateAsync({ appId: "test", privateKey: "test" });
    else if (operation === "refresh") await result.current.refresh.mutateAsync();
    else await result.current.remove.mutateAsync();
  });
  for (const team of [undefined, "a", "b"]) expect(client.getQueryState(qkTemplates.list(team))?.isInvalidated).toBe(true);
  client.clear();
});
