// @vitest-environment jsdom
import { fireEvent, render, screen } from "@testing-library/react";
import { expect, it } from "vitest";
import { draftKey, useComposerDraftStore } from "~/stores/composer-drafts";
import { HomeEmptyState } from "./home-empty-state";

it("labels the open-ended starter without its trailing colon, and still fills the colon in", () => {
  render(<HomeEmptyState sessionId="s1" threadId="t1" />);
  expect(screen.queryByRole("button", { name: /:$/ })).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Start a task" }));
  expect(useComposerDraftStore.getState().byKey[draftKey("s1", "t1")]?.text).toBe("Start a task: ");
});

it("lets a later starter replace an earlier starter's untouched text", () => {
  render(<HomeEmptyState sessionId="s2" threadId="t2" />);
  fireEvent.click(screen.getByRole("button", { name: "Start a task" }));
  fireEvent.click(screen.getByRole("button", { name: "What needs me today?" }));
  expect(useComposerDraftStore.getState().byKey[draftKey("s2", "t2")]?.text).toBe("What needs me today?");
});

it("never replaces text the person typed", () => {
  useComposerDraftStore.getState().setText(draftKey("s3", "t3"), "Start a task: fix the login bug");
  render(<HomeEmptyState sessionId="s3" threadId="t3" />);
  fireEvent.click(screen.getByRole("button", { name: "What needs me today?" }));
  expect(useComposerDraftStore.getState().byKey[draftKey("s3", "t3")]?.text).toBe("Start a task: fix the login bug");
});
