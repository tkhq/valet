// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { ShareArtifactResponse } from "@valet/api/wire";
import { api } from "~/api/client";
import type { OwnerFilter } from "~/api/client";
import { CreateArtifactDialog } from "./create-artifact";

const navigate = vi.fn();
vi.mock("@tanstack/react-router", () => ({ useNavigate: () => navigate }));
vi.mock("~/api/client", () => ({ api: {
  ensureWorkspaceConversation: vi.fn(),
  ensureWorkspaceRuntime: vi.fn(),
  createThread: vi.fn(),
  createArtifactFromTemplate: vi.fn(),
} }));

const personal: OwnerFilter = { ownerType: "user", ownerId: "u1" };
const team: OwnerFilter = { ownerType: "team", ownerId: "team-1" };
const created: ShareArtifactResponse = { id: "artifact-1", path: "inline/new", url: "https://valet.invalid/a/token", visibility: "org", version: 1, updatedAt: 0 };

function show(owner = personal) {
  const onOpenChange = vi.fn();
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const view = render(<CreateArtifactDialog open owner={owner} onOpenChange={onOpenChange} />, {
    wrapper: ({ children }) => <QueryClientProvider client={client}>{children}</QueryClientProvider>,
  });
  return { ...view, onOpenChange };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(api.ensureWorkspaceConversation).mockResolvedValue({ sessionId: "personal-session", threadId: "fresh-thread" });
  vi.mocked(api.ensureWorkspaceRuntime).mockResolvedValue({ sessionId: "private-helper", workspaceSessionId: "team-root" });
  vi.mocked(api.createThread).mockResolvedValue({ id: "team-thread", sessionId: "team-execution", createdAt: 0, lastUserActivityAt: 0 });
  vi.mocked(api.createArtifactFromTemplate).mockResolvedValue(created);
});
afterEach(cleanup);

describe("create artifact", () => {
  it("offers only supported templates and states the personal audience before publishing", async () => {
    show();
    expect(screen.getByRole("dialog", { name: "Create artifact" })).toBeTruthy();
    const templates = within(screen.getByRole("radiogroup", { name: "Template" }));
    expect(templates.getAllByRole("radio")).toHaveLength(2);
    expect(templates.getByRole("radio", { name: /^Document/, checked: true })).toBeTruthy();
    expect(templates.getByRole("radio", { name: /^HTML Page/, checked: false })).toBeTruthy();
    expect(screen.getByText(/organization can view/)).toBeTruthy();
    fireEvent.change(screen.getByRole("textbox", { name: "Artifact title" }), { target: { value: "Release plan" } });
    fireEvent.click(screen.getByRole("button", { name: "Create artifact" }));
    await waitFor(() => expect(navigate).toHaveBeenCalledWith({ to: "/artifacts/$id", params: { id: "artifact-1" } }));
    expect(api.ensureWorkspaceConversation).toHaveBeenCalledWith("user", { fresh: true });
    expect(api.createArtifactFromTemplate).toHaveBeenCalledWith(expect.objectContaining({
      key: expect.stringMatching(/^template-/), title: "Release plan", format: "markdown", content: expect.stringContaining("# Release plan"),
    }), personal, { sessionId: "personal-session", threadId: "fresh-thread" });
    expect(api.ensureWorkspaceRuntime).not.toHaveBeenCalled();
  });

  it("updates the suggested title when choosing a template and preserves a custom title", () => {
    show();
    const title = screen.getByRole("textbox", { name: "Artifact title" });
    const html = screen.getByRole("radio", { name: /^HTML Page/ });
    const document = screen.getByRole("radio", { name: /^Document/ });
    fireEvent.click(html);
    expect(screen.getByRole("radio", { name: /^HTML Page/, checked: true })).toBe(html);
    expect(screen.getByRole("radio", { name: /^Document/, checked: false })).toBe(document);
    expect(title.getAttribute("value")).toBe("Project overview");
    fireEvent.change(title, { target: { value: "Launch plan" } });
    fireEvent.click(document);
    expect(title.getAttribute("value")).toBe("Launch plan");
  });

  it("publishes HTML under the selected team using a shared team conversation", async () => {
    show(team);
    expect(screen.getByText(/team members can view/i)).toBeTruthy();
    fireEvent.click(screen.getByRole("radio", { name: /^HTML Page/ }));
    fireEvent.change(screen.getByRole("textbox", { name: "Artifact title" }), { target: { value: "Team launch" } });
    fireEvent.click(screen.getByRole("button", { name: "Create artifact" }));
    await waitFor(() => expect(navigate).toHaveBeenCalled());
    expect(api.ensureWorkspaceRuntime).toHaveBeenCalledWith("team-1");
    expect(api.createThread).toHaveBeenCalledWith("team-root", {});
    expect(api.ensureWorkspaceConversation).not.toHaveBeenCalled();
    expect(api.createArtifactFromTemplate).toHaveBeenCalledWith(expect.objectContaining({ title: "Team launch", format: "html" }), team,
      { sessionId: "team-execution", threadId: "team-thread" });
  });

  it("reuses the conversation and publish key after a publish failure", async () => {
    vi.mocked(api.createArtifactFromTemplate).mockRejectedValueOnce(new Error("Connection lost"));
    show();
    fireEvent.click(screen.getByRole("button", { name: "Create artifact" }));
    expect((await screen.findByRole("alert")).textContent).toContain("Try again");
    expect(screen.getByRole("textbox", { name: "Artifact title" }).getAttribute("value")).toBe("Project brief");
    const firstRequest = vi.mocked(api.createArtifactFromTemplate).mock.calls[0]?.[0];
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    await waitFor(() => expect(navigate).toHaveBeenCalled());
    expect(api.ensureWorkspaceConversation).toHaveBeenCalledTimes(1);
    const retryRequest = vi.mocked(api.createArtifactFromTemplate).mock.calls[1]?.[0];
    expect(retryRequest?.key).toBe(firstRequest?.key);
    expect(api.createArtifactFromTemplate).toHaveBeenLastCalledWith(firstRequest, personal,
      { sessionId: "personal-session", threadId: "fresh-thread" });
  });

  it("keeps source failures actionable and does not publish without a source", async () => {
    vi.mocked(api.ensureWorkspaceConversation).mockRejectedValueOnce(new Error("Unavailable"));
    show();
    fireEvent.click(screen.getByRole("button", { name: "Create artifact" }));
    expect((await screen.findByRole("alert")).textContent).toContain("Try again");
    expect(api.createArtifactFromTemplate).not.toHaveBeenCalled();
    expect(navigate).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    await waitFor(() => expect(navigate).toHaveBeenCalled());
  });

  it("disables creation for a blank title and while a request is in progress", async () => {
    vi.mocked(api.ensureWorkspaceConversation).mockReturnValue(new Promise(() => {}));
    show();
    const title = screen.getByRole("textbox", { name: "Artifact title" });
    fireEvent.change(title, { target: { value: "   " } });
    expect(screen.getByRole("button", { name: "Create artifact" }).hasAttribute("disabled")).toBe(true);
    fireEvent.change(title, { target: { value: "Plan" } });
    fireEvent.click(screen.getByRole("button", { name: "Create artifact" }));
    expect(await screen.findByRole("button", { name: "Creating…" })).toBeTruthy();
    expect(title.hasAttribute("disabled")).toBe(true);
    expect(screen.getAllByRole("radio").every((option) => option.matches(":disabled"))).toBe(true);
    expect(screen.getByRole("button", { name: "Cancel" }).hasAttribute("disabled")).toBe(true);
  });

  it("discards an old owner's creation when the selected workspace changes", async () => {
    let finishPersonal: ((source: { sessionId: string; threadId: string }) => void) | undefined;
    vi.mocked(api.ensureWorkspaceConversation).mockReturnValue(new Promise((resolve) => { finishPersonal = resolve; }));
    const view = show();
    fireEvent.click(screen.getByRole("button", { name: "Create artifact" }));
    view.rerender(<CreateArtifactDialog open owner={team} onOpenChange={view.onOpenChange} />);
    expect(screen.getByText(/team members can view/i)).toBeTruthy();
    await act(async () => { finishPersonal?.({ sessionId: "old-personal-session", threadId: "old-thread" }); });
    expect(api.createArtifactFromTemplate).not.toHaveBeenCalled();
    expect(navigate).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Create artifact" }));
    await waitFor(() => expect(navigate).toHaveBeenCalled());
    expect(api.createArtifactFromTemplate).toHaveBeenCalledTimes(1);
    expect(api.createArtifactFromTemplate).toHaveBeenCalledWith(expect.objectContaining({ format: "markdown" }), team,
      { sessionId: "team-execution", threadId: "team-thread" });
  });
});
