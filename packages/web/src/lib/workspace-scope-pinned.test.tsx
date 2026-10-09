// @vitest-environment jsdom
import { render, screen } from "@testing-library/react";
import { beforeEach, expect, it, vi } from "vitest";
import { PinnedWorkspaceScope, WorkspaceScopeProvider, useWorkspaceScope } from "./workspace-scope";

vi.mock("@tanstack/react-router", () => ({ useSearch: () => ({}) }));
vi.mock("~/api/settings", () => ({ useOrg: () => ({ data: undefined }), useTeams: () => ({ data: undefined }) }));
vi.mock("~/components/session/assistant-rail", () => ({
  eligibleTeams: () => [{ id: "t1", name: "platform" }, { id: "t2", name: "support" }],
}));

beforeEach(() => {
  window.sessionStorage.clear();
});

function Probe({ label }: { label: string }) {
  const scope = useWorkspaceScope();
  return <span>{`${label} ${scope.key} ${scope.teamId ?? "none"}`}</span>;
}

// Settings pages name their scope in the URL, so they pin it instead of
// reading the switcher. The switcher itself must not move.
it("pins a team scope for its children only", () => {
  render(
    <>
      <PinnedWorkspaceScope teamId="team-1"><Probe label="inside" /></PinnedWorkspaceScope>
      <Probe label="outside" />
    </>,
  );
  expect(screen.getByText("inside team-1 team-1")).toBeTruthy();
  expect(screen.getByText("outside user none")).toBeTruthy();
});

it("pins the personal workspace", () => {
  render(<PinnedWorkspaceScope teamId={undefined}><Probe label="inside" /></PinnedWorkspaceScope>);
  expect(screen.getByText("inside user none")).toBeTruthy();
});

// The tab title names a workspace. On a pinned settings page it must name the
// page's scope, not the switcher's, or a team's name labels a personal page.
it("names the pinned workspace in the tab title while mounted", () => {
  window.sessionStorage.setItem("valet:workspace", "t1");
  const view = render(
    <WorkspaceScopeProvider><PinnedWorkspaceScope teamId={undefined}><Probe label="page" /></PinnedWorkspaceScope></WorkspaceScopeProvider>,
  );
  expect(screen.getByText("page user none")).toBeTruthy();
  expect(document.title).toBe("Personal · Valet");

  view.rerender(
    <WorkspaceScopeProvider><PinnedWorkspaceScope teamId="t2"><Probe label="page" /></PinnedWorkspaceScope></WorkspaceScopeProvider>,
  );
  expect(document.title).toBe("support · Valet");

  view.rerender(<WorkspaceScopeProvider><Probe label="page" /></WorkspaceScopeProvider>);
  expect(document.title).toBe("platform · Valet");
});
