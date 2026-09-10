// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { CredentialSummary, ListCredentialsResponse, ListPluginsResponse, TeamSummary } from "@valet/api/wire";
import { api, ApiError } from "~/api/client";
import { qkIntegrations } from "~/api/integrations";

let teamId: string | undefined;
const setKey = vi.fn();
vi.mock("~/lib/workspace-scope", () => ({
  PERSONAL: "user",
  useWorkspaceScope: () => ({ teamId, setKey }),
}));
vi.mock("@tanstack/react-router", () => ({
  createFileRoute: () => (config: unknown) => config,
  useSearch: () => ({}),
  useNavigate: () => vi.fn(),
}));

function team(id: string, name: string, callerRole: TeamSummary["callerRole"]): TeamSummary {
  return { id, name, callerRole, orgId: "org", origin: "local", externalId: null,
    createdAt: 1, memberCount: 2, defaultModel: null };
}
let teams: TeamSummary[];
let orgRole: "admin" | "member";
let teamsError: Error | null;
let teamsLoading: boolean;
let directoryError: Error | null;
vi.mock("~/api/settings", async (importOriginal) => ({
  ...await importOriginal<typeof import("~/api/settings")>(),
  useTeams: () => ({ data: { teams }, isLoading: teamsLoading, error: teamsError }),
  useMe: () => ({ data: { orgRole, name: "My account", email: "me@example.com" }, isLoading: false, error: null }),
  useOrgDirectory: () => ({
    data: { users: [{ userId: "u1", name: "Alice" }] },
    isLoading: false, error: directoryError,
  }),
}));
vi.mock("~/api/queries", async (importOriginal) => ({
  ...await importOriginal<typeof import("~/api/queries")>(),
  useIdentityLinks: () => ({ data: { links: [] }, isLoading: false, error: null }),
}));
vi.mock("~/api/repos", async (importOriginal) => ({
  ...await importOriginal<typeof import("~/api/repos")>(),
  useConnectGithub: () => ({ mutateAsync: vi.fn(), isPending: false, error: null }),
  useGithubOrgStatus: () => ({ data: undefined }),
}));

import { IntegrationsPage } from "./integrations";

const PERSONAL_PLUGINS: ListPluginsResponse = { plugins: [{
  name: "typefully", version: "1", actionCount: 0, dynamic: true,
  services: [{ service: "typefully", type: "api_key", configKeys: ["accessToken"],
    connected: false, connect: "manual", dynamic: true, actions: [] }],
}] };
const A: CredentialSummary = { service: "linear", type: "oauth2", connectedAt: "2026-09-10", delegatedFrom: "u1" };
const B: CredentialSummary = { service: "sentry", type: "api_key", connectedAt: "2026-09-10" };

function mount() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
  const page = () => <QueryClientProvider client={client}><IntegrationsPage /></QueryClientProvider>;
  const view = render(page());
  return { client, switchTo: (id?: string) => { teamId = id; view.rerender(page()); } };
}

beforeEach(() => {
  vi.restoreAllMocks();
  setKey.mockClear();
  teamId = undefined;
  orgRole = "member";
  teams = [team("a", "Team A", "admin"), team("b", "Team B", "admin")];
  teamsError = null;
  teamsLoading = false;
  directoryError = null;
  vi.spyOn(api, "listPlugins").mockResolvedValue(PERSONAL_PLUGINS);
  vi.spyOn(api, "listCredentials").mockImplementation(async (scope, id) => {
    if (scope !== "team") throw new Error("Unexpected personal credential read");
    return { credentials: id === "a" ? [A] : [B] };
  });
  vi.spyOn(api, "deleteCredential").mockResolvedValue({ ok: true });
});

describe("Integrations workspace isolation", () => {
  it("switches Personal -> team A -> team B -> Personal without retaining forms or team dialogs", async () => {
    const view = mount();
    fireEvent.click(await screen.findByRole("button", { name: "Connect Typefully" }));
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    const token = screen.getByLabelText("API key");
    fireEvent.change(token, { target: { value: "personal-token-draft" } });

    view.switchTo("a");
    expect(screen.queryByDisplayValue("personal-token-draft")).toBeNull();
    expect(screen.queryByText("Typefully")).toBeNull();
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(await screen.findByText("Shared by Alice")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Stop sharing Linear with Team A" }));

    view.switchTo("b");
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(screen.queryByText("Linear")).toBeNull();
    expect(await screen.findByText("Sentry")).toBeTruthy();
    expect(screen.getByText("Stored on the team")).toBeTruthy();
    expect(api.listCredentials).toHaveBeenCalledWith("team", "a");
    expect(api.listCredentials).toHaveBeenCalledWith("team", "b");
    expect(api.listPlugins).toHaveBeenCalledTimes(1);

    view.switchTo();
    expect(await screen.findByRole("button", { name: "Connect Typefully" })).toBeTruthy();
    expect(screen.queryByText("Sentry")).toBeNull();
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(api.deleteCredential).not.toHaveBeenCalled();
  });

  it("does not show cached personal or team A data while team B loads or fails", async () => {
    teamId = "a";
    const view = mount();
    await screen.findByText("Linear");
    let rejectRead: (error: Error) => void = () => {};
    vi.mocked(api.listCredentials).mockReturnValueOnce(new Promise((_resolve, reject) => { rejectRead = reject; }));
    view.switchTo("b");
    expect(screen.getByText("Loading credentials…")).toBeTruthy();
    expect(screen.queryByText("Linear")).toBeNull();
    await act(async () => rejectRead(new Error("Forbidden")));
    expect(await screen.findByText("Could not load credentials. Reload the page.")).toBeTruthy();
    expect(screen.queryByRole("button", { name: /Disconnect|Stop sharing/ })).toBeNull();
    expect(api.listPlugins).not.toHaveBeenCalled();
  });

  it("keeps members read-only and explains empty teams", async () => {
    teamId = "a";
    teams = [team("a", "Team A", "member")];
    const view = mount();
    await screen.findByText("Shared by Alice");
    expect(screen.getByText("Only team or organization admins can remove team connections.")).toBeTruthy();
    expect(screen.queryByRole("button", { name: /Disconnect|Stop sharing/ })).toBeNull();
    act(() => view.client.setQueryData<ListCredentialsResponse>(qkIntegrations.credentials("team", "a"), { credentials: [] }));
    expect(await screen.findByText(/No credentials in Team A yet/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Switch to Personal" }));
    expect(setKey).toHaveBeenCalledWith("user");
  });

  it("lets an org admin manage a team they are not on and reports delete errors", async () => {
    teamId = "b";
    teams = [team("b", "Team B", null)];
    orgRole = "admin";
    vi.mocked(api.deleteCredential).mockRejectedValue(new ApiError(404, "Access changed. Reload the page."));
    mount();
    fireEvent.click(await screen.findByRole("button", { name: "Disconnect Sentry from Team B" }));
    fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Disconnect" }));
    expect(await screen.findByText("Access changed. Reload the page.")).toBeTruthy();
    expect(api.deleteCredential).toHaveBeenCalledWith("sentry", { scope: "team", teamId: "b" });
  });

  it("reports team lookup failures without falling back to personal integrations", async () => {
    teamId = "a";
    teamsError = new Error("Unavailable");
    mount();
    expect(screen.getByText("Could not load team integrations. Reload the page to try again.")).toBeTruthy();
    expect(api.listCredentials).not.toHaveBeenCalled();
    expect(api.listPlugins).not.toHaveBeenCalled();
  });

  it("waits for teams and handles a missing team", () => {
    teamId = "a";
    teamsLoading = true;
    const view = mount();
    expect(screen.getByText("Loading team integrations…")).toBeTruthy();
    expect(api.listCredentials).not.toHaveBeenCalled();
    teamsLoading = false;
    teams = [];
    view.switchTo("a");
    expect(screen.getByText(/This team is unavailable/)).toBeTruthy();
    expect(api.listPlugins).not.toHaveBeenCalled();
  });

  it("keeps credentials visible with IDs when member names fail", async () => {
    teamId = "a";
    directoryError = new Error("Unavailable");
    mount();
    expect(await screen.findByText("Shared by u1")).toBeTruthy();
    expect(screen.getByText(/Could not load member names/)).toBeTruthy();
  });

  it("hides stale credentials and an open dialog when a refetch loses access", async () => {
    teamId = "a";
    const view = mount();
    fireEvent.click(await screen.findByRole("button", { name: "Stop sharing Linear with Team A" }));
    vi.mocked(api.listCredentials).mockRejectedValue(new Error("Forbidden"));
    await act(async () => { await view.client.invalidateQueries({ queryKey: qkIntegrations.credentials("team", "a") }); });
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(screen.queryByText("Linear")).toBeNull();
    expect(screen.getByText("Could not load credentials. Reload the page.")).toBeTruthy();
  });
});
