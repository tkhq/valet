// @vitest-environment jsdom
import { beforeEach, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { PageTitleProvider } from "~/lib/page-title";
import { AppSessionPage, Route } from "./sessions.$sessionId";
let owner: { type: "user" | "team"; id: string } = { type: "team", id: "team-a" };
let threadTitle: string | undefined;
let runtime = "runtime-team";
let sessionId = "runtime-team";

vi.mock("@tanstack/react-router", async importOriginal => {
  const actual = await importOriginal<typeof import("@tanstack/react-router")>();
  return { ...actual,
    Navigate: ({ search }: { search: Record<string, string> }) => <div data-testid="redirect">{JSON.stringify(search)}</div>,
    Link: ({ children, to, params }: { children: ReactNode; to: string; params: Record<string, string> }) => <a data-testid="origin" data-to={to} data-params={JSON.stringify(params)}>{children}</a>,
  };
});
vi.mock("~/api/queries", () => ({ useThreads: () => ({ data: { threads: [{ id: "source-thread", title: threadTitle, key: "web:default", createdAt: 1 }] } }), useSession: () => ({ data: { owner, title: "Investigate failure", isWorkspaceRuntime: sessionId === runtime, parentWork: sessionId === "child" ? { sessionId: runtime, threadId: "parent-thread" } : undefined } }) }));
vi.mock("~/lib/workspace-scope", () => ({ useAdoptWorkspaceScope: () => undefined }));
vi.mock("~/components/session/session-view", () => ({ SessionView: () => <div>Work history</div> }));
vi.mock("~/components/session/child-panel", () => ({ ChildPanel: () => null }));
vi.mock("~/components/security/engagement-panel", () => ({ SecuritySessionLayout: () => null }));
vi.mock("~/components/workflows/agent-approvals", () => ({ WorkflowAgentApprovals: () => null }));
beforeEach(() => {
  vi.clearAllMocks();
  threadTitle = undefined;
  owner = { type: "team", id: "team-a" }; runtime = "runtime-team"; sessionId = runtime;
  vi.spyOn(Route, "useParams").mockImplementation(() => ({ sessionId }));
  vi.spyOn(Route, "useSearch").mockReturnValue({ thread: "source-thread" });
  vi.spyOn(Route, "useNavigate").mockReturnValue(vi.fn());
});
it("redirects a team runtime to its workspace and preserves the source thread", () => {
  render(<AppSessionPage />);
  expect(JSON.parse(screen.getByTestId("redirect").textContent ?? "{}")).toEqual({ workspace: "team-a", thread: "source-thread" });
});
it("resolves personal runtime links through the personal workspace", () => {
  owner = { type: "user", id: "u1" };
  render(<AppSessionPage />);
  expect(JSON.parse(screen.getByTestId("redirect").textContent ?? "{}").workspace).toBe("user");
});
it("keeps child history in its own runtime and points back to the team origin", () => {
  sessionId = "child";
  render(<PageTitleProvider workspaceName="Platform"><AppSessionPage /></PageTitleProvider>);
  expect(document.title).toBe("Investigate failure · Platform · Valet");
  expect(screen.getByText("Work history")).toBeTruthy();
  expect(screen.queryByTestId("redirect")).toBeNull();
  expect(screen.getByTestId("origin").getAttribute("data-to")).toBe("/threads/$threadId");
  expect(JSON.parse(screen.getByTestId("origin").getAttribute("data-params") ?? "{}")).toEqual({ threadId: "parent-thread" });
});

it("uses the selected thread title for a direct thread link", () => {
  sessionId = "child";
  threadTitle = "Review login fix";
  render(<PageTitleProvider workspaceName="Platform"><AppSessionPage /></PageTitleProvider>);
  expect(document.title).toBe("Review login fix · Platform · Valet");
});

it("uses the default thread title when the session URL omits its thread", () => {
  sessionId = "child";
  threadTitle = "Default discussion";
  vi.spyOn(Route, "useSearch").mockReturnValue({});
  render(<PageTitleProvider workspaceName="Platform"><AppSessionPage /></PageTitleProvider>);
  expect(document.title).toBe("Default discussion · Platform · Valet");
});
