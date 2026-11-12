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
