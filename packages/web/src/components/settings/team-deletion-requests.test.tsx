// @vitest-environment jsdom
import type { ReactNode } from "react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { TeamDeletionRequestSummary } from "@valet/api/wire";
import { api, ApiError } from "~/api/client";
import { TeamDeletionRequests } from "./team-deletion-requests";

vi.mock("~/api/settings", () => ({ useMe: () => ({ data: { id: "member" } }) }));
const pending: TeamDeletionRequestSummary = {
  id: "request-1", orgId: "org-1", teamId: "team-a", resourceType: "workflow", resourceId: "workflow-1",
  resourceLabel: "Daily report", requestedBy: "member", requesterName: "Alex", requesterIsMember: true,
  reason: "No longer needed", requestedAt: 1000, expiresAt: 9000000000000, status: "pending",
  decidedBy: null, decidedAt: null, decisionNote: null, lastRefusal: null,
};
let client: QueryClient;
beforeEach(() => {
  client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  vi.spyOn(api, "listTeamDeletionRequests").mockResolvedValue({ requests: [pending], nextCursor: null });
  vi.spyOn(api, "listTeamDeletionTargets").mockResolvedValue({ targets: [{ resourceType: "workflow", resourceId: "workflow-1", label: "Daily report" }] });
  vi.spyOn(api, "submitTeamDeletionRequest").mockResolvedValue({ request: { id: "request-1" }, created: true });
  vi.spyOn(api, "decideTeamDeletionRequest").mockResolvedValue({ ok: true });
});
afterEach(() => { client.clear(); vi.restoreAllMocks(); });
const wrapper = ({ children }: { children: ReactNode }) => <QueryClientProvider client={client}>{children}</QueryClientProvider>;

it("lets a member request deletion with the styled picker and withdraw only their own request", async () => {
  render(<TeamDeletionRequests teamId="team-a" canManage={false} />, { wrapper });
  await screen.findByText("Daily report (Workflow) — pending");
  expect(screen.queryByRole("button", { name: "Approve" })).toBeNull();
  fireEvent.keyDown(screen.getByRole("button", { name: "Resource to delete" }), { key: "Enter" });
  fireEvent.click(screen.getByRole("menuitem", { name: "Daily report (Workflow)" }));
  fireEvent.change(screen.getByRole("textbox", { name: "Deletion reason" }), { target: { value: "Replaced" } });
  fireEvent.click(screen.getByRole("button", { name: "Request deletion" }));
  await waitFor(() => expect(api.submitTeamDeletionRequest).toHaveBeenCalledWith("team-a", { resourceType: "workflow", resourceId: "workflow-1", reason: "Replaced" }));
  fireEvent.click(screen.getByRole("button", { name: "Withdraw" }));
  expect(screen.getByText("This closes the request without deleting the resource.")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Withdraw request" }));
  await waitFor(() => expect(api.decideTeamDeletionRequest).toHaveBeenCalledWith("team-a", "request-1", "withdraw", ""));
});

it("confirms approval, retains provider refusal, and lets the admin retry", async () => {
  vi.mocked(api.decideTeamDeletionRequest).mockRejectedValueOnce(new ApiError(409, "Conflict", { error: "Cancel active runs first." }));
  render(<TeamDeletionRequests teamId="team-a" canManage />, { wrapper });
  fireEvent.click(await screen.findByRole("button", { name: "Approve" }));
  expect(screen.getByText(/Approval deletes this resource for everyone/)).toBeTruthy();
  fireEvent.change(screen.getByRole("textbox", { name: "Decision note" }), { target: { value: "Approved cleanup" } });
  fireEvent.click(screen.getByRole("button", { name: "Approve deletion" }));
  await screen.findByText("Cancel active runs first.");
  expect(screen.getByRole("dialog")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Approve deletion" }));
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  expect(api.decideTeamDeletionRequest).toHaveBeenLastCalledWith("team-a", "request-1", "approve", "Approved cleanup");
});

it("displays departed requesters and never offers decisions on expired requests", async () => {
  vi.mocked(api.listTeamDeletionRequests).mockResolvedValue({ requests: [{ ...pending, status: "expired", requesterIsMember: false }], nextCursor: null });
  render(<TeamDeletionRequests teamId="team-a" canManage />, { wrapper });
  await screen.findByText(/no longer a team member/);
  expect(screen.queryByRole("button", { name: "Approve" })).toBeNull();
  expect(screen.queryByRole("button", { name: "Withdraw" })).toBeNull();
});

it("clears confirmation and entered fields when changing teams", async () => {
  const view = render(<TeamDeletionRequests teamId="team-a" canManage />, { wrapper });
  fireEvent.click(await screen.findByRole("button", { name: "Decline" }));
  fireEvent.change(screen.getByRole("textbox", { name: "Decision note" }), { target: { value: "Private note for A" } });
  view.rerender(<TeamDeletionRequests teamId="team-b" canManage />);
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  expect(api.listTeamDeletionRequests).toHaveBeenCalledWith("team-b", { status: "pending", limit: 50, cursor: undefined });
  expect(api.decideTeamDeletionRequest).not.toHaveBeenCalled();
});

it("closes approval when admin access is lost", async () => {
  const view = render(<TeamDeletionRequests teamId="team-a" canManage />, { wrapper });
  fireEvent.click(await screen.findByRole("button", { name: "Approve" }));
  view.rerender(<TeamDeletionRequests teamId="team-a" canManage={false} />);
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  view.rerender(<TeamDeletionRequests teamId="team-a" canManage />);
  expect(screen.queryByRole("dialog")).toBeNull();
});

it("handles empty targets without enabling submission", async () => {
  vi.mocked(api.listTeamDeletionTargets).mockResolvedValue({ targets: [] });
  vi.mocked(api.listTeamDeletionRequests).mockResolvedValue({ requests: [], nextCursor: null });
  render(<TeamDeletionRequests teamId="team-a" canManage={false} />, { wrapper });
  await screen.findByText("No resources are available for deletion requests.");
  expect(screen.getByRole("button", { name: "Request deletion" }).hasAttribute("disabled")).toBe(true);
});

it("shows a retryable list error and blocks submission", async () => {
  vi.mocked(api.listTeamDeletionRequests).mockRejectedValue(new Error("offline"));
  render(<TeamDeletionRequests teamId="team-a" canManage />, { wrapper });
  await screen.findByText("Could not load deletion requests.");
  expect(screen.getByRole("button", { name: "Request deletion" }).hasAttribute("disabled")).toBe(true);
  vi.mocked(api.listTeamDeletionRequests).mockResolvedValue({ requests: [], nextCursor: null });
  fireEvent.click(screen.getByRole("button", { name: "Retry" }));
  await screen.findByText("No deletion requests.");
});


it("pages pending requests, resets the cursor for history and team changes, and decides a later request", async () => {
  const older = { ...pending, id: "older", resourceLabel: "Oldest pending" };
  vi.mocked(api.listTeamDeletionRequests).mockImplementation(async (_teamId, options) => {
    if (options?.status === "history") return { requests: [{ ...pending, status: "withdrawn" }], nextCursor: null };
    return options?.cursor ? { requests: [older], nextCursor: null } : { requests: [pending], nextCursor: "page-two" };
  });
  const view = render(<TeamDeletionRequests teamId="team-a" canManage />, { wrapper });
  await screen.findByText("Daily report (Workflow) — pending");
  await waitFor(() => expect(screen.getByRole("button", { name: "Next" }).hasAttribute("disabled")).toBe(false));
  fireEvent.click(screen.getByRole("button", { name: "Next" }));
  await screen.findByText("Oldest pending (Workflow) — pending");
  expect(screen.getByText("Page 2")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Approve" }));
  fireEvent.click(screen.getByRole("button", { name: "Approve deletion" }));
  await waitFor(() => expect(api.decideTeamDeletionRequest).toHaveBeenCalledWith("team-a", "older", "approve", ""));
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  fireEvent.click(screen.getByRole("button", { name: "Previous" }));
  await screen.findByText("Daily report (Workflow) — pending");
  await waitFor(() => expect(screen.getByRole("button", { name: "Next" }).hasAttribute("disabled")).toBe(false));
  fireEvent.click(screen.getByRole("button", { name: "Next" }));
  await screen.findByText("Oldest pending (Workflow) — pending");
  fireEvent.keyDown(screen.getByRole("button", { name: "Deletion request status" }), { key: "Enter" });
  fireEvent.click(screen.getByRole("menuitem", { name: "History" }));
  await screen.findByText("Daily report (Workflow) — withdrawn");
  expect(api.listTeamDeletionRequests).toHaveBeenLastCalledWith("team-a", { status: "history", limit: 50, cursor: undefined });
  expect(screen.queryByRole("button", { name: "Approve" })).toBeNull();
  view.rerender(<TeamDeletionRequests teamId="team-b" canManage />);
  await waitFor(() => expect(api.listTeamDeletionRequests).toHaveBeenLastCalledWith("team-b", { status: "pending", limit: 50, cursor: undefined }));
});

it("keeps Previous available when a later page is empty or fails", async () => {
  vi.mocked(api.listTeamDeletionRequests).mockImplementation(async (_teamId, options) => {
    if (options?.cursor) throw new Error("page unavailable");
    return { requests: [pending], nextCursor: "next" };
  });
  render(<TeamDeletionRequests teamId="team-a" canManage />, { wrapper });
  fireEvent.click(await screen.findByRole("button", { name: "Next" }));
  await screen.findByText("Could not load deletion requests.");
  expect(screen.getByRole("button", { name: "Next" }).hasAttribute("disabled")).toBe(true);
  fireEvent.click(screen.getByRole("button", { name: "Previous" }));
  await screen.findByText("Daily report (Workflow) — pending");
  vi.mocked(api.listTeamDeletionRequests).mockImplementation(async (_teamId, options) => ({ requests: options?.cursor ? [] : [pending], nextCursor: options?.cursor ? null : "next" }));
  await waitFor(() => expect(screen.getByRole("button", { name: "Next" }).hasAttribute("disabled")).toBe(false));
  fireEvent.click(screen.getByRole("button", { name: "Next" }));
  await screen.findByText("No deletion requests.");
  fireEvent.click(screen.getByRole("button", { name: "Previous" }));
  await screen.findByText("Daily report (Workflow) — pending");
});
