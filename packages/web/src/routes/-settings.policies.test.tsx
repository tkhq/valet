// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ActionPolicyWire, ListOrgPoliciesResponse, TeamSummary } from "@valet/api/wire";
import { api, ApiError } from "~/api/client";
import { qkPolicies } from "~/api/policies";

let teamId: string | undefined;
let role: TeamSummary["callerRole"];
let teamsError: Error | null;
let teamsLoading: boolean;
let orgAdmin: boolean;
vi.mock("@tanstack/react-router", () => ({ createFileRoute: () => (config: unknown) => config }));
vi.mock("~/lib/workspace-scope", () => ({ useWorkspaceScope: () => ({ teamId }) }));
vi.mock("~/api/settings", () => ({ useMe: () => ({ data: { orgRole: orgAdmin ? "admin" : "member" } }), useTeams: () => ({
  data: teamsLoading ? undefined : { teams: ["a", "b"].map((id) => ({ id, name: `Team ${id}`, callerRole: role })) },
  error: teamsError,
}) }));
vi.mock("~/components/settings/policy-overrides-section", () => ({ PolicyOverridesSection: () => <p>Personal overrides</p> }));
vi.mock("~/components/settings/grants-section", () => ({ GrantsSection: () => <p>Personal grants</p> }));
import { PoliciesPage } from "./settings.policies";

function policy(id: string): ActionPolicyWire {
  return { id, service: id, actionId: null, riskLevel: null, mode: "require_approval", appliesIn: "any",
    paramMatchers: [], origin: "admin", managedBy: "admin", expiresAt: null, createdAt: 1, updatedAt: 1 };
}
function mount() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const page = () => <QueryClientProvider client={client}><PoliciesPage /></QueryClientProvider>;
  const view = render(page());
  return { client, redraw: () => view.rerender(page()) };
}
beforeEach(() => {
  vi.restoreAllMocks();
  teamId = "a";
  role = "admin";
  orgAdmin = false;
  teamsError = null;
  teamsLoading = false;
  vi.spyOn(api, "listPlugins").mockResolvedValue({ plugins: [] });
  vi.spyOn(api, "listTeamPolicies").mockImplementation(async (id) => ({ policies: [policy(id)] }));
  vi.spyOn(api, "createTeamPolicy").mockResolvedValue(policy("created"));
  vi.spyOn(api, "patchTeamPolicy").mockResolvedValue(policy("patched"));
  vi.spyOn(api, "deleteTeamPolicy").mockResolvedValue(policy("deleted"));
  vi.spyOn(api, "listOrgPolicies").mockRejectedValue(new Error("Unexpected org read"));
  vi.spyOn(api, "createOrgPolicy").mockRejectedValue(new Error("Unexpected org write"));
});

describe("team Policies settings", () => {
  it("lets a non-member org admin manage the team's rules", async () => {
    role = null;
    orgAdmin = true;
    mount();
    await screen.findByText("service: a");
    expect(screen.getAllByRole("heading", { name: /^Policies/ })).toHaveLength(1);
    const heading = screen.getByRole("heading", { name: "Policies · Team a", level: 1 });
    const rules = screen.getByRole("heading", { name: "Action rules", level: 2 });
    expect(heading.compareDocumentPosition(rules) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(screen.queryByText("require_approval")).toBeNull();
    expect(screen.getByText("All runs", { selector: "span" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Create policy" })).toBeTruthy();
  });
  it("uses only team-scoped CRUD and leaves other policy caches alone", async () => {
    const { client } = mount();
    client.setQueryData(qkPolicies.orgPolicies(), { policies: [policy("org")] });
    client.setQueryData(qkPolicies.teamPolicies("b"), { policies: [policy("b")] });
    await screen.findByText("service: a");
    fireEvent.click(screen.getByRole("radio", { name: "Risk level" }));
    fireEvent.click(screen.getByRole("button", { name: "Create policy" }));
    await waitFor(() => expect(api.createTeamPolicy).toHaveBeenCalledWith("a", {
      riskLevel: "low", mode: "require_approval", appliesIn: "any", paramMatchers: undefined,
    }));
    fireEvent.change(screen.getByLabelText("Mode for policy a"), { target: { value: "deny" } });
    await waitFor(() => expect(api.patchTeamPolicy).toHaveBeenCalledWith("a", "a", { mode: "deny" }));
    fireEvent.click(screen.getByRole("button", { name: "Delete policy service: a" }));
    fireEvent.click(screen.getByRole("button", { name: "Delete policy" }));
    await waitFor(() => expect(api.deleteTeamPolicy).toHaveBeenCalledWith("a", "a"));
    expect(client.getQueryState(qkPolicies.orgPolicies())?.isInvalidated).toBe(false);
    expect(client.getQueryState(qkPolicies.teamPolicies("b"))?.isInvalidated).toBe(false);
    expect(api.listOrgPolicies).not.toHaveBeenCalled();
    expect(api.createOrgPolicy).not.toHaveBeenCalled();
  });

  it("discards drafts when switching teams, going personal, and returning", async () => {
    const view = mount();
    await screen.findByText("service: a");
    fireEvent.click(screen.getByRole("button", { name: "Add condition" }));
    fireEvent.change(screen.getByLabelText("Matcher path"), { target: { value: "team-a-draft" } });
    fireEvent.click(screen.getByRole("button", { name: "Delete policy service: a" }));
    expect(screen.getByRole("dialog")).toBeTruthy();
    teamId = "b";
    view.redraw();
    await screen.findByText("service: b");
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(screen.queryByText("service: a")).toBeNull();
    expect(screen.queryByDisplayValue("team-a-draft")).toBeNull();
    expect(screen.queryByLabelText("Matcher path")).toBeNull();
    teamId = undefined;
    view.redraw();
    expect(screen.getByText("Personal overrides")).toBeTruthy();
    expect(screen.getByText("Personal grants")).toBeTruthy();
    expect(screen.queryByText("service: b")).toBeNull();
    teamId = "a";
    view.redraw();
    await screen.findByText("service: a");
    expect(screen.queryByDisplayValue("team-a-draft")).toBeNull();
  });

  it("makes members read-only and discards forms when admin authority is lost", async () => {
    const view = mount();
    await screen.findByText("service: a");
    fireEvent.click(screen.getByRole("button", { name: "Add condition" }));
    role = "member";
    view.redraw();
    expect(screen.getByText("Only team admins can change policies.")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Create policy" })).toBeNull();
    expect(screen.getByLabelText("Mode for policy a")).toHaveProperty("disabled", true);
    expect(screen.getByRole("button", { name: "Delete policy service: a" })).toHaveProperty("disabled", true);
    expect(api.createTeamPolicy).not.toHaveBeenCalled();
    expect(api.patchTeamPolicy).not.toHaveBeenCalled();
    expect(api.deleteTeamPolicy).not.toHaveBeenCalled();
    role = "admin";
    view.redraw();
    expect(screen.queryByLabelText("Matcher path")).toBeNull();
  });

  it("waits for membership and refuses missing teams or failed membership reads", async () => {
    teamsLoading = true;
    const view = mount();
    expect(screen.getByRole("status").textContent).toBe("Loading team…");
    expect(api.listTeamPolicies).not.toHaveBeenCalled();
    teamsLoading = false;
    teamId = "gone";
    view.redraw();
    expect(screen.getByRole("alert").textContent).toContain("Team unavailable");
    teamId = "a";
    role = null;
    view.redraw();
    expect(screen.getByRole("alert").textContent).toContain("Team unavailable");
    role = "admin";
    teamsError = new Error("Unavailable");
    view.redraw();
    expect(screen.getByRole("alert").textContent).toContain("Could not load this team");
    expect(api.listTeamPolicies).not.toHaveBeenCalled();
  });

  it("shows policy loading and ignores a previous team's late response", async () => {
    let finish: (value: ListOrgPoliciesResponse) => void = () => {};
    vi.mocked(api.listTeamPolicies).mockImplementation((id) => id === "a"
      ? new Promise((resolve) => { finish = resolve; }) : Promise.resolve({ policies: [policy("b")] }));
    const view = mount();
    expect(screen.getByRole("status").textContent).toBe("Loading team policies…");
    teamId = "b";
    view.redraw();
    await screen.findByText("service: b");
    await act(async () => finish({ policies: [policy("a")] }));
    expect(screen.queryByText("service: a")).toBeNull();
  });

  it("keeps a pending team mutation bound to its original team after navigation", async () => {
    let finish: (value: ActionPolicyWire) => void = () => {};
    vi.mocked(api.createTeamPolicy).mockImplementation(() => new Promise((resolve) => { finish = resolve; }));
    const view = mount();
    await screen.findByText("service: a");
    fireEvent.click(screen.getByRole("radio", { name: "Risk level" }));
    fireEvent.click(screen.getByRole("button", { name: "Create policy" }));
    await waitFor(() => expect(api.createTeamPolicy).toHaveBeenCalledTimes(1));
    teamId = "b";
    view.redraw();
    await screen.findByText("service: b");
    fireEvent.click(screen.getByRole("button", { name: "Add condition" }));
    fireEvent.change(screen.getByLabelText("Matcher path"), { target: { value: "team-b-draft" } });
    await act(async () => finish(policy("created")));
    expect(screen.getByDisplayValue("team-b-draft")).toBeTruthy();
    expect(vi.mocked(api.createTeamPolicy).mock.calls.map(([team]) => team)).toEqual(["a"]);
    expect(api.listOrgPolicies).not.toHaveBeenCalled();
  });

  it("shows API validation errors and keeps member kill switches disabled", async () => {
    vi.mocked(api.listPlugins).mockResolvedValue({ plugins: [{ name: "demo", version: "1", actionCount: 0,
      services: [{ service: "demo", type: "api_key", configKeys: [], connected: false, connect: "manual", actions: [] }] }] });
    vi.mocked(api.patchTeamPolicy).mockRejectedValue(new ApiError(400, "Invalid policy", { error: "Team policies cannot loosen an org deny." }));
    const view = mount();
    await screen.findByText("service: a");
    fireEvent.change(screen.getByLabelText("Mode for policy a"), { target: { value: "allow" } });
    expect(await screen.findByRole("alert")).toHaveProperty("textContent", "Team policies cannot loosen an org deny.");
    role = "member";
    view.redraw();
    expect(await screen.findByRole("switch", { name: "Kill switch for demo" })).toHaveProperty("disabled", true);
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("hides cached policies and forms when a policy refetch fails", async () => {
    const { client } = mount();
    await screen.findByText("service: a");
    fireEvent.click(screen.getByRole("button", { name: "Add condition" }));
    vi.mocked(api.listTeamPolicies).mockRejectedValue(new Error("Forbidden"));
    await act(async () => { await client.invalidateQueries({ queryKey: qkPolicies.teamPolicies("a") }); });
    await screen.findByRole("alert");
    expect(screen.queryByText("service: a")).toBeNull();
    expect(screen.queryByRole("button", { name: "Create policy" })).toBeNull();
    vi.mocked(api.listTeamPolicies).mockResolvedValue({ policies: [] });
    await act(async () => { await client.invalidateQueries({ queryKey: qkPolicies.teamPolicies("a") }); });
    await screen.findByText("No policies yet.");
    expect(screen.queryByLabelText("Matcher path")).toBeNull();
  });
});
