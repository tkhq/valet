// @vitest-environment jsdom
import { render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { GetChangelogResponse } from "@valet/api/wire";

const data: GetChangelogResponse = {
  manifest: {
    schema: "valet-changelog/v1",
    generatedAt: "2026-09-09T12:00:00Z",
    checkpoints: [
      {
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
