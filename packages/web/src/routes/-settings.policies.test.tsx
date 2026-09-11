// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ActionPolicyWire, ListOrgPoliciesResponse, TeamSummary } from "@valet/api/wire";
import { api } from "~/api/client";
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
  vi.spyOn(api, "listMyPolicyOverrides").mockResolvedValue({ overrides: [] });
  vi.spyOn(api, "listMyGrants").mockResolvedValue({ grants: [] });
  vi.spyOn(api, "putTeamPolicyOverride").mockResolvedValue(policy("saved"));
  vi.spyOn(api, "deleteTeamGrant").mockResolvedValue({ ok: true });
  vi.spyOn(api, "listTeamGrants").mockImplementation(async id => ({ grants: [{ id: `grant-${id}`, sessionId: `session-${id}`, workflowExecutionId: null, policyKey: "gmail.send", grantedBy: "other", createdAt: 0 }] }));
  vi.spyOn(api, "listPlugins").mockResolvedValue({ plugins: [] });
  vi.spyOn(api, "listTeamPolicies").mockImplementation(async (id) => ({ policies: [policy(id)] }));
  vi.spyOn(api, "createTeamPolicy").mockResolvedValue(policy("created"));
  vi.spyOn(api, "patchTeamPolicy").mockResolvedValue(policy("patched"));
  vi.spyOn(api, "deleteTeamPolicy").mockResolvedValue(policy("deleted"));
  vi.spyOn(api, "listOrgPolicies").mockRejectedValue(new Error("Unexpected org read"));
  vi.spyOn(api, "createOrgPolicy").mockRejectedValue(new Error("Unexpected org write"));
});

describe("team Policies settings parity", () => {
  it("matches personal section order and uses scoped upsert, never additive create", async () => {
    const { client, redraw } = mount();
    client.setQueryData(qkPolicies.orgPolicies(), { policies: [policy("org")] });
    client.setQueryData(qkPolicies.teamPolicies("b"), { policies: [policy("b")] });
    await screen.findByText("service: a");
    expect(screen.getAllByRole("heading", { level: 2 }).map(x => x.textContent)).toEqual(["Team policy overrides", "New override", "Team active grants"]);
    expect(screen.queryByRole("switch")).toBeNull();
    fireEvent.click(screen.getByRole("radio", { name: "Risk level" }));
    fireEvent.click(screen.getByRole("button", { name: "Save override" }));
    await waitFor(() => expect(api.putTeamPolicyOverride).toHaveBeenCalledWith("a", { riskLevel: "low", mode: "allow" }));
    fireEvent.click(screen.getByRole("button", { name: "Delete override service: a" }));
    expect(api.deleteTeamPolicy).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Delete override" }));
    await waitFor(() => expect(api.deleteTeamPolicy).toHaveBeenCalledWith("a", "a"));
    expect(client.getQueryState(qkPolicies.orgPolicies())?.isInvalidated).toBe(false);
    expect(client.getQueryState(qkPolicies.teamPolicies("b"))?.isInvalidated).toBe(false);
    expect(api.createTeamPolicy).not.toHaveBeenCalled();
    expect(api.listOrgPolicies).not.toHaveBeenCalled();
    teamId = undefined; redraw();
    await screen.findByText("No overrides yet.");
    expect(screen.getAllByRole("heading", { level: 2 }).map(x => x.textContent)).toEqual(["My policy overrides", "New override", "My active grants"]);
  });

  it("discards drafts and mutation errors across team, role, and personal switches", async () => {
    const view = mount();
    await screen.findByText("service: a");
    fireEvent.click(screen.getByRole("radio", { name: "Action" }));
    role = "member"; view.redraw();
    expect(screen.queryByRole("button", { name: "Save override" })).toBeNull();
    expect(screen.getByRole("button", { name: "Delete override service: a" })).toHaveProperty("disabled", true);
    expect(screen.getByRole("button", { name: /Revoke grant/ })).toHaveProperty("disabled", true);
    role = "admin"; view.redraw();
    expect(screen.getByRole("radio", { name: "Service" })).toHaveProperty("checked", true);
    fireEvent.click(screen.getByRole("radio", { name: "Action" }));
    teamId = "b"; view.redraw(); await screen.findByText("service: b");
    expect(screen.getByRole("radio", { name: "Service" })).toHaveProperty("checked", true);
    expect(screen.queryByText("service: a")).toBeNull();
    teamId = undefined; view.redraw(); await screen.findByText("No overrides yet.");
    teamId = "a"; view.redraw(); await screen.findByText("service: a");
    expect(screen.getByRole("radio", { name: "Service" })).toHaveProperty("checked", true);
  });

  it("retains advanced conditions, expiry and scope separately and revokes by scoped id", async () => {
    vi.mocked(api.listTeamPolicies).mockResolvedValue({ policies: [policy("simple"), { ...policy("advanced"), service: "simple", appliesIn: "workflow", expiresAt: 2000000000000, paramMatchers: [{ path: "to", op: "eq", value: "example" }] }] });
    mount(); await screen.findByText("service: simple");
    fireEvent.click(screen.getByText("Advanced rules (1)"));
    expect(await screen.findByText(/"path": "to"/)).toBeTruthy();
    expect(screen.getByText("Workflows", { selector: "span" })).toBeTruthy();
    expect(screen.getByText(/^Expires /)).toBeTruthy();
    fireEvent.change(screen.getByLabelText("Mode for policy advanced"), { target: { value: "deny" } });
    await waitFor(() => expect(api.patchTeamPolicy).toHaveBeenCalledWith("a", "advanced", { mode: "deny" }));
    fireEvent.click(screen.getByRole("button", { name: "Delete policy service: simple" }));
    fireEvent.click(screen.getByRole("button", { name: "Delete policy" }));
    await waitFor(() => expect(api.deleteTeamPolicy).toHaveBeenCalledWith("a", "advanced"));

  });

  it("offers advanced authoring even without advanced rows and creates conditional rules through existing CRUD", async () => {
    mount(); await screen.findByText("service: a");
    fireEvent.click(screen.getByText("Advanced rules (0)"));
    const heading = await screen.findByRole("heading", { name: "New policy" });
    const section = heading.closest("section");
    if (!section) throw new Error("New policy section missing");
    const form = within(section);
    fireEvent.click(form.getByRole("radio", { name: "Risk level" }));
    fireEvent.click(form.getByRole("button", { name: "Add condition" }));
    fireEvent.change(form.getByLabelText("Matcher path"), { target: { value: "to" } });
    fireEvent.change(form.getByLabelText("Matcher value"), { target: { value: "example" } });
    fireEvent.click(form.getByRole("button", { name: "Create policy" }));
    await waitFor(() => expect(api.createTeamPolicy).toHaveBeenCalledWith("a", {
      riskLevel: "low", mode: "require_approval", appliesIn: "any", paramMatchers: [{ path: "to", op: "eq", value: "example" }],
    }));
    expect(screen.queryByRole("switch")).toBeNull();
    expect(api.putTeamPolicyOverride).not.toHaveBeenCalled();
  });

  it("revoke follows team grant ID and hides cached data after either query fails", async () => {
    const { client } = mount(); await screen.findByText("service: a");
    fireEvent.click(screen.getByRole("button", { name: /Revoke grant/ }));
    fireEvent.click(screen.getByRole("button", { name: "Revoke grant" }));
    await waitFor(() => expect(api.deleteTeamGrant).toHaveBeenCalledWith("a", "grant-a"));
    fireEvent.click(screen.getByRole("radio", { name: "Action" }));
    vi.mocked(api.listTeamGrants).mockRejectedValue(new Error("Forbidden"));
    await act(async () => { await client.invalidateQueries({ queryKey: ["policies", "team", "a", "grants"] }); });
    await screen.findByRole("alert");
    expect(screen.queryByText("service: a")).toBeNull();
    expect(screen.queryByRole("button", { name: "Save override" })).toBeNull();
    vi.mocked(api.listTeamGrants).mockResolvedValue({ grants: [] });
    await act(async () => { await client.invalidateQueries({ queryKey: ["policies", "team", "a", "grants"] }); });
    await screen.findByText("service: a");
    expect(screen.getByRole("radio", { name: "Service" })).toHaveProperty("checked", true);
  });

  it("gates membership and drops late responses from the previous team", async () => {
    teamsLoading = true;
    const view = mount(); expect(api.listTeamPolicies).not.toHaveBeenCalled();
    teamsLoading = false; teamId = "gone"; view.redraw(); expect(screen.getByRole("alert").textContent).toContain("Team unavailable");
    teamId = "a"; teamsError = new Error("Failed"); view.redraw(); expect(screen.getByRole("alert").textContent).toContain("Could not load");
    teamsError = null;
    let finish: (value: ListOrgPoliciesResponse) => void = () => {};
    vi.mocked(api.listTeamPolicies).mockImplementation(id => id === "a" ? new Promise(resolve => { finish = resolve; }) : Promise.resolve({ policies: [policy("b")] }));
    view.redraw(); expect(screen.getByRole("status")).toBeTruthy();
    teamId = "b"; view.redraw(); await screen.findByText("service: b");
    await act(async () => finish({ policies: [policy("a")] })); expect(screen.queryByText("service: a")).toBeNull();
  });
});
