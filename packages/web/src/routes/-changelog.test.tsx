// @vitest-environment jsdom
import { render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { GetChangelogResponse } from "@valet/api/wire";

const data: GetChangelogResponse = {
  manifest: {
    schema: "valet-changelog/v2",
    generatedAt: "2026-09-09T12:00:00Z",
    checkpoints: [
      {
        kind: "released",
        id: "1.0.0@abc",
        version: "1.0.0",
        releasedAt: "2026-09-09T12:00:00Z",
        releasedSha: "abc",
        previousSha: null,
        entries: [
          {
            title: "Open the changelog",
            description: "Users can read release notes inside Valet.",
            category: "feature",
            sources: { commitSha: "abc", pullRequest: 42 },
            followUp: false,
          },
        ],
      },
    ],
  },
  artifact: { version: "1.0.0", sha: "abc", checkpointId: "1.0.0@abc", status: "exact" },
};

vi.mock("~/api/changelog", () => ({
  useChangelog: () => ({ data, isPending: false, isError: false }),
}));
vi.mock("~/api/settings", () => ({
  useMe: () => ({ data: { id: "user-1" } }),
}));
vi.mock("@tanstack/react-router", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@tanstack/react-router")>();
  return { ...actual, createFileRoute: () => () => ({}) };
});

import { ChangelogPage } from "./changelog";

describe("ChangelogPage", () => {
  beforeEach(() => window.localStorage.clear());

  it("shows dated user-facing entries, source links, and marks the release read", async () => {
    render(<ChangelogPage />);
    expect(screen.getByRole("heading", { name: "Changelog" })).toBeTruthy();
    expect(screen.getByText("Open the changelog")).toBeTruthy();
    expect(screen.getByText("Users can read release notes inside Valet.")).toBeTruthy();
    expect(screen.getByRole("link", { name: "PR #42" }).getAttribute("href")).toContain("/pull/42");
    await waitFor(() => {
      expect(window.localStorage.getItem("valet:changelog-seen:user-1")).toBe("1.0.0@abc");
    });
    expect(await screen.findByText("New")).toBeTruthy();
  });

  it("shows an unreleased build first with its timestamp, SHA, link, and empty state", () => {
    const released = data.manifest.checkpoints[0];
    data.manifest.checkpoints.unshift({
      kind: "unreleased",
      id: "unreleased@def123456789",
      buildSha: "def123456789",
      builtAt: "2026-09-10T12:00:00Z",
      previousSha: "abc",
      buildUrl: "https://github.com/tkhq/valet/actions/runs/1",
      entries: [],
    });
    data.artifact = {
      version: "Unreleased",
      sha: "def123456789",
      checkpointId: "unreleased@def123456789",
      status: "unreleased",
    };
    render(<ChangelogPage />);
    const sections = screen.getAllByRole("heading", { level: 2 });
    expect(sections.map((heading) => heading.textContent)).toEqual(["Unreleased", "1.0.0"]);
    expect(screen.getByRole("link", { name: "Build def123456" }).getAttribute("href")).toContain(
      "/commit/def123456789",
    );
    expect(screen.getByRole("link", { name: "Build" }).getAttribute("href")).toContain("/actions/runs/1");
    expect(screen.getByText("No user-facing changes are pending in this build.")).toBeTruthy();
    data.manifest.checkpoints = [released];
    data.artifact = { version: "1.0.0", sha: "abc", checkpointId: "1.0.0@abc", status: "exact" };
  });

  it("shows releases that contain no user-facing changes", () => {
    const entries = data.manifest.checkpoints[0].entries;
    data.manifest.checkpoints[0].entries = [];
    render(<ChangelogPage />);
    expect(screen.getByText("No user-facing changes shipped in this release.")).toBeTruthy();
    data.manifest.checkpoints[0].entries = entries;
  });

  it("explains when this commit has no exact checkpoint", () => {
    data.artifact.status = "latest-known";
    render(<ChangelogPage />);
    expect(screen.getByText(/This build has no release checkpoint/)).toBeTruthy();
    data.artifact.status = "exact";
  });
});
