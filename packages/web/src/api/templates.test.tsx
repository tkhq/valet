// @vitest-environment jsdom
/**
 * The gallery's listing is per-WORKSPACE, not per-user: the server stamps
 * each template's `requires[].connected` against the principal the install
 * would act as, which is the team when a team workspace is open. So the
 * query has to send that team id, and the cache has to key on it — a shared
 * key would serve the personal answer under a team's name, and the card
 * would offer or withhold Install on the wrong credentials.
 */
import { describe, expect, it, vi, beforeEach } from "vitest";
import type { ReactNode } from "react";
import { renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ListWorkflowTemplatesResponse } from "@valet/api/wire";

const listWorkflowTemplates = vi.fn();
vi.mock("./client", () => ({
  api: { listWorkflowTemplates: (teamId?: string) => listWorkflowTemplates(teamId) },
}));

/** The active workspace, rewritten per test before the hook renders. */
let teamId: string | undefined;
vi.mock("~/lib/workspace-scope", () => ({
  useWorkspaceScope: () => ({ teamId }),
}));

import { qkTemplates, useWorkflowTemplates } from "./templates";

/** One template, connected only for the caller. */
const PERSONAL: ListWorkflowTemplatesResponse = {
  templates: [
    {
      id: "daily-triage-digest",
      name: "Daily triage digest",
      description: "Reads Linear each morning.",
      steps: ["Read"],
      schedule: null,
      requires: [{ service: "linear", connected: true }],
      inputs: [],
      caveats: [],
    },
  ],
};

/** The same template, connected only for the team. */
const TEAM: ListWorkflowTemplatesResponse = {
  templates: [
    { ...PERSONAL.templates[0]!, requires: [{ service: "linear", connected: false }] },
  ],
};

function makeWrapper(client: QueryClient) {
  return function Wrapper({ children }: { children: ReactNode }) {
    return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
  };
}

function newClient(): QueryClient {
  return new QueryClient({ defaultOptions: { queries: { retry: false } } });
}

beforeEach(() => {
  listWorkflowTemplates.mockReset();
  teamId = undefined;
});

describe("useWorkflowTemplates", () => {
  it("asks about the caller's own workspace when no team is open", async () => {
    listWorkflowTemplates.mockResolvedValue(PERSONAL);
    const { result } = renderHook(() => useWorkflowTemplates(), {
      wrapper: makeWrapper(newClient()),
    });

    await waitFor(() => expect(result.current.data).toEqual(PERSONAL));
    expect(listWorkflowTemplates).toHaveBeenCalledWith(undefined);
  });

  it("asks about the team the workspace switcher names", async () => {
    teamId = "team_ops";
    listWorkflowTemplates.mockResolvedValue(TEAM);
    const { result } = renderHook(() => useWorkflowTemplates(), {
      wrapper: makeWrapper(newClient()),
    });

    await waitFor(() => expect(result.current.data).toEqual(TEAM));
    expect(listWorkflowTemplates).toHaveBeenCalledWith("team_ops");
  });

  it("does not serve one workspace's answer under another", async () => {
    const client = newClient();
    client.setQueryData(qkTemplates.list(undefined), PERSONAL);
    teamId = "team_ops";
    listWorkflowTemplates.mockResolvedValue(TEAM);

    const { result } = renderHook(() => useWorkflowTemplates(), {
      wrapper: makeWrapper(client),
    });

    // The warm personal entry must not be shown while the team's answer is
    // still in flight: it would offer Install on the caller's credentials.
    expect(result.current.data).toBeUndefined();
    await waitFor(() => expect(result.current.data).toEqual(TEAM));
    expect(client.getQueryData(qkTemplates.list(undefined))).toEqual(PERSONAL);
  });
});
