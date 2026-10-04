// @vitest-environment jsdom
import { beforeEach, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { DraftAccountBoundary } from "./__root";
import { draftKey, useComposerDraft, useComposerDraftStore } from "~/stores/composer-drafts";

const identity = vi.hoisted(() => ({ data: { orgId: "org", id: "alice" }, isFetching: false, error: null }));
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
});

it("hides cached-account drafts while verifying, then mounts only the verified owner's draft", () => {
  const store = useComposerDraftStore.getState();
  store.activateOwner(JSON.stringify(["org", "alice"]));
  store.setText(draftKey("shared-session", "shared-thread"), "Alice private draft");
  const view = render(<DraftAccountBoundary><Draft /></DraftAccountBoundary>);
  expect(screen.getByRole<HTMLTextAreaElement>("textbox").value).toBe("Alice private draft");
  identity.isFetching = true;
  view.rerender(<DraftAccountBoundary><Draft /></DraftAccountBoundary>);
  expect(screen.queryByRole("textbox")).toBeNull();
  identity.data = { orgId: "org", id: "bob" };
  identity.isFetching = false;
  view.rerender(<DraftAccountBoundary><Draft /></DraftAccountBoundary>);
  expect(screen.getByRole<HTMLTextAreaElement>("textbox").value).toBe("");
  expect(useComposerDraftStore.getState().owner).toBe(JSON.stringify(["org", "bob"]));
});
