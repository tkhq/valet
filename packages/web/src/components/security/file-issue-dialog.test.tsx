// @vitest-environment jsdom
/**
 * File-issue dialog (valet-security M8, spec §Filing issues): a
 * disconnected provider renders disabled with its corrective copy, the
 * Linear team id is remembered per engagement in localStorage, and the
 * idempotent repeat reads "Already filed:" with the existing link.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type {
  GetReposResponse,
  ListPluginsResponse,
  SecurityEngagementWire,
  SecurityFileIssueResponse,
  SecurityFindingWire,
} from "@valet/api/wire";

const listPluginsMock = vi.fn<() => Promise<ListPluginsResponse>>();
const getReposMock = vi.fn<() => Promise<GetReposResponse>>();
const fileIssueMock = vi.fn<
  (
    id: string,
    findingId: string,
    body: { provider: "github" | "linear"; repo?: string; teamId?: string },
  ) => Promise<SecurityFileIssueResponse>
>();

vi.mock("~/api/client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("~/api/client")>();
  return {
    ...actual,
    api: {
      ...actual.api,
      listPlugins: () => listPluginsMock(),
      getRepos: () => getReposMock(),
      fileSecurityIssue: (
        id: string,
        findingId: string,
        body: { provider: "github" | "linear"; repo?: string; teamId?: string },
      ) => fileIssueMock(id, findingId, body),
    },
  };
});

import { FileIssueDialog, linearTeamStorageKey } from "./file-issue-dialog";

const engagement: SecurityEngagementWire = {
  id: "eng-1",
  sessionId: "s-1",
  status: "running",
  repoFullName: "acme/site",
  repoRef: "a".repeat(40),
  plan: "cells: []",
  baseRef: null,
  changedPaths: null,
  hasRepoConfig: false,
  focus: null,
  invariants: null,
  categories: null,
  configPersonas: null,
  configTools: null,
  createdAt: 1,
  updatedAt: 2,
};

const finding: SecurityFindingWire = {
  id: "f-1",
  cellId: "cell-1",
  fingerprint: "fp-1",
  severity: "high",
  title: "Token logged",
  file: "src/app.ts",
  line: 4,
  body: "evidence",
  status: "open",
  statusReason: null,
  statusActor: null,
  createdAt: 100,
};

function pluginsFixture(connected: { github: boolean; linear: boolean }): ListPluginsResponse {
  const service = (name: "github" | "linear", isConnected: boolean) => ({
    name,
    version: "0.0.1",
    actionCount: 1,
    services: [
      {
        service: name,
        type: "oauth2" as const,
        configKeys: [],
        connected: isConnected,
        connect: "oauth" as const,
        actions: [],
      },
    ],
  });
  return { plugins: [service("github", connected.github), service("linear", connected.linear)] };
}

function renderDialog(onClose = vi.fn()) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(
    <QueryClientProvider client={client}>
      <FileIssueDialog
        sessionId="s-1"
        engagement={engagement}
        target={{ mode: "single", finding }}
        onClose={onClose}
      />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  listPluginsMock.mockReset();
  getReposMock.mockReset();
  fileIssueMock.mockReset();
  window.localStorage.clear();
  getReposMock.mockResolvedValue({ repos: [], connected: false, installed: false });
});

describe("FileIssueDialog", () => {
  it("disables a disconnected provider and names the corrective action", async () => {
    listPluginsMock.mockResolvedValue(pluginsFixture({ github: true, linear: false }));
    getReposMock.mockResolvedValue({ repos: [], connected: true, installed: false });
    renderDialog();

    const linearButton = await screen.findByRole("button", { name: /Linear/ });
    await waitFor(() => expect(linearButton.hasAttribute("disabled")).toBe(true));
    expect(
      screen.getByText(/Linear is not connected\. Connect the Linear integration in Settings\./),
    ).toBeTruthy();
    expect(screen.getByRole("button", { name: /GitHub/ }).hasAttribute("disabled")).toBe(false);
  });

  it("remembers the Linear team id per engagement", async () => {
    listPluginsMock.mockResolvedValue(pluginsFixture({ github: false, linear: true }));
    renderDialog();

    const linearButton = await screen.findByRole("button", { name: /Linear/ });
    await waitFor(() => expect(linearButton.hasAttribute("disabled")).toBe(false));
    fireEvent.click(linearButton);
    fireEvent.change(screen.getByLabelText("Linear team id"), { target: { value: "TKAI" } });
    expect(window.localStorage.getItem(linearTeamStorageKey("eng-1"))).toBe("TKAI");
  });

  it("files through the finding route and shows the idempotent copy on a repeat", async () => {
    listPluginsMock.mockResolvedValue(pluginsFixture({ github: true, linear: false }));
    getReposMock.mockResolvedValue({ repos: [], connected: true, installed: false });
    fileIssueMock.mockResolvedValue({
      link: {
        id: "link-1",
        findingId: "f-1",
        provider: "github",
        externalId: "acme/site#7",
        url: "https://github.com/acme/site/issues/7",
        createdBy: "u-1",
        createdAt: 9,
      },
      created: false,
    });
    renderDialog();

    const githubButton = await screen.findByRole("button", { name: /GitHub/ });
    await waitFor(() => expect(githubButton.hasAttribute("disabled")).toBe(false));
    fireEvent.click(githubButton);
    fireEvent.click(screen.getByRole("button", { name: "File issue" }));

    await waitFor(() =>
      expect(fileIssueMock).toHaveBeenCalledWith("s-1", "f-1", {
        provider: "github",
        repo: "acme/site",
      }),
    );
    expect(await screen.findByText("Already filed:")).toBeTruthy();
    expect(
      screen.getByRole("link", { name: "https://github.com/acme/site/issues/7" }),
    ).toBeTruthy();
  });
});
