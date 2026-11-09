// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import type { RunCodeReviewRequest } from "@valet/api/wire";

let runError: Error | null = null;
const mutate = vi.fn((_body: RunCodeReviewRequest, _options?: { onSuccess?: () => void }) => {});

vi.mock("~/api/code-review", () => ({
  useRunCodeReview: () => ({ mutate, isPending: false, error: runError }),
}));

import { RunReviewDialog } from "./run-review-dialog";

beforeEach(() => {
  mutate.mockReset();
  runError = null;
});

describe("RunReviewDialog", () => {
  it("starts a review of the pull request in the workspace", () => {
    render(<RunReviewDialog open onOpenChange={() => {}} teamId="team-1" />);
    fireEvent.change(screen.getByLabelText("Pull request URL"), { target: { value: " https://github.com/acme/site/pull/7 " } });
    expect(screen.queryByLabelText("Commit")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Review" }));
    expect(mutate.mock.calls[0][0]).toEqual({ url: "https://github.com/acme/site/pull/7", teamId: "team-1" });
  });

  it("sends shadow mode and a commit only together", () => {
    render(<RunReviewDialog open onOpenChange={() => {}} />);
    fireEvent.change(screen.getByLabelText("Pull request URL"), { target: { value: "https://github.com/acme/site/pull/7" } });
    fireEvent.click(screen.getByRole("checkbox", { name: "Shadow mode" }));
    fireEvent.change(screen.getByLabelText("Commit"), { target: { value: "abcdef1" } });
    fireEvent.click(screen.getByRole("button", { name: "Review" }));
    expect(mutate.mock.calls[0][0]).toEqual({ url: "https://github.com/acme/site/pull/7", shadow: true, commit: "abcdef1" });
  });

  it("shows the server's error", () => {
    runError = new Error("No code review line in this workspace covers acme/site. Turn the repository on in Code review first.");
    render(<RunReviewDialog open onOpenChange={() => {}} />);
    expect(screen.getByRole("alert").textContent).toContain("Turn the repository on in Code review first");
  });
});
