// @vitest-environment jsdom
import { beforeEach, expect, it, vi } from "vitest";
import { ApiError } from "~/api/client";
import { render, screen } from "@testing-library/react";
import { DraftAccountBoundary } from "./__root";
import { draftKey, useComposerDraft, useComposerDraftStore } from "~/stores/composer-drafts";

const identity = vi.hoisted(() => ({ data: { orgId: "org", id: "alice" }, isFetching: false, error: null as Error | null }));
vi.mock("~/api/settings", async (original) => ({
  ...await original<typeof import("~/api/settings")>(),
  useMe: () => identity,
}));

function Draft() {
  const draft = useComposerDraft(draftKey("shared-session", "shared-thread"));
  return <textarea aria-label="Draft" value={draft.text} readOnly />;
}

beforeEach(() => {
  localStorage.clear();
  useComposerDraftStore.setState({ owner: "", byKey: {} });
  identity.data = { orgId: "org", id: "alice" };
  identity.isFetching = false;
  identity.error = null;
});

it("preserves verified drafts during refetch, then switches to the new account", () => {
  const store = useComposerDraftStore.getState();
  store.activateOwner(JSON.stringify(["org", "alice"]));
  store.setText(draftKey("shared-session", "shared-thread"), "Alice private draft");
  const view = render(<DraftAccountBoundary><Draft /></DraftAccountBoundary>);
  expect(screen.getByRole<HTMLTextAreaElement>("textbox").value).toBe("Alice private draft");
  identity.isFetching = true;
  view.rerender(<DraftAccountBoundary><Draft /></DraftAccountBoundary>);
  expect(screen.getByRole<HTMLTextAreaElement>("textbox").value).toBe("Alice private draft");
  identity.data = { orgId: "org", id: "bob" };
  identity.isFetching = false;
  view.rerender(<DraftAccountBoundary><Draft /></DraftAccountBoundary>);
  expect(screen.getByRole<HTMLTextAreaElement>("textbox").value).toBe("");
  expect(useComposerDraftStore.getState().owner).toBe(JSON.stringify(["org", "bob"]));
});

it("keeps the mounted composer on transient errors but hides it after authentication fails", () => {
  const view = render(<DraftAccountBoundary><Draft /></DraftAccountBoundary>);
  const composer = screen.getByRole("textbox");
  identity.error = new ApiError(503, "temporarily unavailable");
  view.rerender(<DraftAccountBoundary><Draft /></DraftAccountBoundary>);
  expect(screen.getByRole("textbox")).toBe(composer);
  identity.error = new ApiError(401, "signed out");
  view.rerender(<DraftAccountBoundary><Draft /></DraftAccountBoundary>);
  expect(screen.queryByRole("textbox")).toBeNull();
});

it("does not expose cached drafts before the initial account check completes", () => {
  useComposerDraftStore.getState().activateOwner(JSON.stringify(["org", "alice"]));
  identity.isFetching = true;
  render(<DraftAccountBoundary><Draft /></DraftAccountBoundary>);
  expect(screen.queryByRole("textbox")).toBeNull();
});
