// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import type { ListArtifactsResponse } from "@valet/api/wire";
import type { OwnerFilter } from "~/api/client";

const navigate = vi.fn();
const refetch = vi.fn();
const request = vi.fn();
let owner: OwnerFilter | undefined;
let search: Record<string, string>;
let pending: boolean;
let failed: boolean;
let identityFailed: boolean;
let data: ListArtifactsResponse;
vi.mock("@tanstack/react-router", () => ({
  createFileRoute: () => (config: unknown) => config,
  useNavigate: () => navigate,
  useSearch: () => search,
  Link: ({ to, params, children }: { to: string; params?: { token: string }; children: ReactNode }) => <a href={params ? `/a/${params.token}` : to}>{children}</a>,
}));
vi.mock("~/lib/use-list-owner", () => ({ useListOwner: () => owner }));
vi.mock("~/api/settings", () => ({ useMe: () => ({ isError: identityFailed }) }));
vi.mock("~/components/workspace-clause", () => ({ WorkspaceClause: () => <span>Personal</span> }));
vi.mock("~/api/artifacts", () => ({ useArtifacts: (scope: unknown, options: unknown) => {
  request(scope, options);
  return { data, isPending: pending, isError: failed, refetch };
} }));
import { ArtifactsPage } from "./artifacts";

describe("workspace artifacts", () => {
  beforeEach(() => {
    cleanup(); vi.clearAllMocks();
    owner = { ownerType: "user", ownerId: "u1" }; search = {};
    pending = false; failed = false; identityFailed = false;
    data = { artifacts: [{ id: "a1", title: "Report", token: "capability", url: "https://api.invalid/a/capability",
      path: "reports/result.html", format: "html", icon: "", version: 2, sharedVersion: null,
      visibility: "org", ownerType: "user", actorUserId: "u1", revoked: false, createdAt: 0, updatedAt: 0 }], nextCursor: null };
  });
  it("lists the selected owner and opens the in-app artifact route", () => {
    render(<ArtifactsPage />);
    expect(request).toHaveBeenLastCalledWith(owner, { enabled: true, limit: 50, cursor: undefined });
    expect(screen.getByRole("link", { name: "Report" }).getAttribute("href")).toBe("/a/capability");
    expect(screen.getByRole("link", { name: "Memory" }).getAttribute("href")).toBe("/memory");
    expect(screen.getByText(/Page · Version 2/)).toBeTruthy();
  });
  it("disables the list until the owner is known, including identity failure", () => {
    owner = undefined;
    const view = render(<ArtifactsPage />);
    expect(request).toHaveBeenLastCalledWith(undefined, { enabled: false, limit: 50, cursor: undefined });
    expect(screen.queryByRole("link", { name: "Report" })).toBeNull();
    expect(screen.getByText("Loading artifacts…")).toBeTruthy();
    identityFailed = true; view.rerender(<ArtifactsPage />);
    expect(screen.getByRole("alert").textContent).toContain("Reload this page");
  });
  it("pages through the URL and discards another workspace's cursor immediately", () => {
    data.nextCursor = "next";
    const view = render(<ArtifactsPage />);
    fireEvent.click(screen.getByRole("button", { name: "Next" }));
    expect(navigate).toHaveBeenLastCalledWith({ to: "/artifacts", search: { page: "next", pageOwner: "user:u1" } });
    search = { page: "next", pageOwner: "user:u1" }; view.rerender(<ArtifactsPage />);
    expect(request).toHaveBeenLastCalledWith(owner, { enabled: true, limit: 50, cursor: "next" });
    owner = { ownerType: "team", ownerId: "t1" }; view.rerender(<ArtifactsPage />);
    expect(request).toHaveBeenLastCalledWith(owner, { enabled: true, limit: 50, cursor: undefined });
    expect(screen.getByText("Page 1")).toBeTruthy();
  });
  it("keeps pagination available when source visibility filters an entire page", () => {
    data = { artifacts: [], nextCursor: "next" }; render(<ArtifactsPage />);
    expect(screen.getByText(/No visible artifacts/)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Next" }).hasAttribute("disabled")).toBe(false);
  });
  it("shows loading, empty, and retry states", () => {
    pending = true; const view = render(<ArtifactsPage />);
    expect(screen.getByText("Loading artifacts…")).toBeTruthy();
    pending = false; data = { artifacts: [] }; view.rerender(<ArtifactsPage />);
    expect(screen.getByText(/No artifacts yet/)).toBeTruthy();
    failed = true; search = { page: "bad", pageOwner: "user:u1" }; view.rerender(<ArtifactsPage />);
    fireEvent.click(screen.getByRole("button", { name: "Try again" })); expect(refetch).toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "First page" }));
    expect(navigate).toHaveBeenLastCalledWith({ to: "/artifacts", search: { page: undefined, pageOwner: undefined } });
  });
  it("labels team ownership ahead of public visibility and disables revoked links", () => {
    data.artifacts[0] = { ...data.artifacts[0]!, ownerType: "team", visibility: "public" };
    const view = render(<ArtifactsPage />);
    expect(screen.getByText("Team")).toBeTruthy(); expect(screen.queryByText("Public")).toBeNull();
    data.artifacts[0] = { ...data.artifacts[0]!, revoked: true }; view.rerender(<ArtifactsPage />);
    expect(screen.getByText("Revoked")).toBeTruthy(); expect(screen.queryByRole("link", { name: "Report" })).toBeNull();
  });
});
