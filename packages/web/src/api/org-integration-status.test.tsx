// @vitest-environment jsdom
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { GetGithubAppResponse, GetGithubOrgStatusResponse, ListPluginsResponse } from "@valet/api/wire";
import { api } from "./client";
import { qkIntegrations, usePlugins } from "./integrations";
import { qkRepos, useGithubOrgStatus } from "./repos";
import { useDeleteGithubApp, useDeleteSlackApp, useRefreshGithubApp, useSaveGithubAppCredential, useSaveSlackCredential } from "./settings";

const githubApp: GetGithubAppResponse = {
  configured: true, installations: [], webhook: { mode: "manual" }, installationsCheckedAt: null,
};
function catalog(configured: boolean): ListPluginsResponse {
  return { plugins: [{ name: "slack", version: "1", actionCount: 0, services: [{
    service: "slack", type: "bot_token", configKeys: ["accessToken"], connected: false,
    connect: configured ? "org" : "unconfigured", actions: [],
  }] }] };
}

beforeEach(() => vi.restoreAllMocks());

describe("organization mutations refresh member-visible status", () => {
  it.each(["save-slack", "delete-slack", "save-github", "refresh-github", "delete-github"])(
    "%s refreshes a warm status cache without invalidating team credentials", async (operation) => {
      const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
      const wrapper = ({ children }: { children: ReactNode }) => <QueryClientProvider client={client}>{children}</QueryClientProvider>;
      const deleting = operation.startsWith("delete");
      const initial: GetGithubOrgStatusResponse = { configured: deleting, installationCount: deleting ? 1 : 0, suspendedCount: 0 };
      const updated: GetGithubOrgStatusResponse = { configured: !deleting, installationCount: deleting ? 0 : 1, suspendedCount: 0 };
      client.setQueryData(qkRepos.githubOrgStatus(), initial);
      client.setQueryData(qkIntegrations.plugins(), catalog(deleting));
      client.setQueryData(qkIntegrations.credentials("team", "a"), { credentials: [] });
      vi.spyOn(api, "listPlugins").mockResolvedValue(catalog(!deleting));
      vi.spyOn(api, "getGithubOrgStatus").mockResolvedValue(updated);
      vi.spyOn(api, "putCredential").mockResolvedValue({ ok: true });
      vi.spyOn(api, "deleteCredential").mockResolvedValue({ ok: true });
      vi.spyOn(api, "postGithubAppCredential").mockResolvedValue(githubApp);
      vi.spyOn(api, "refreshGithubApp").mockResolvedValue(githubApp);
      vi.spyOn(api, "deleteGithubApp").mockResolvedValue(undefined);
      const { result } = renderHook(() => ({
        plugins: usePlugins(), github: useGithubOrgStatus(),
        saveSlack: useSaveSlackCredential(), deleteSlack: useDeleteSlackApp(),
        saveGithub: useSaveGithubAppCredential(), refreshGithub: useRefreshGithubApp(), deleteGithub: useDeleteGithubApp(),
      }), { wrapper });
      expect(api.listPlugins).not.toHaveBeenCalled();
      expect(api.getGithubOrgStatus).not.toHaveBeenCalled();
      await act(async () => {
        switch (operation) {
          case "save-slack": await result.current.saveSlack.mutateAsync({ accessToken: "test-token", webhookSecret: "test-secret" }); break;
          case "delete-slack": await result.current.deleteSlack.mutateAsync(); break;
          case "save-github": await result.current.saveGithub.mutateAsync({ appId: "test-app", privateKey: "test-key" }); break;
          case "refresh-github": await result.current.refreshGithub.mutateAsync(); break;
          case "delete-github": await result.current.deleteGithub.mutateAsync(); break;
        }
      });
      if (operation.endsWith("slack")) {
        await waitFor(() => expect(result.current.plugins.data).toEqual(catalog(!deleting)));
        expect(api.listPlugins).toHaveBeenCalledTimes(1);
      } else {
        await waitFor(() => expect(result.current.github.data).toEqual(updated));
        expect(api.getGithubOrgStatus).toHaveBeenCalledTimes(1);
      }
      expect(client.getQueryState(qkIntegrations.credentials("team", "a"))?.isInvalidated).toBe(false);
    },
  );
});
