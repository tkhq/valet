// @vitest-environment jsdom
import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, expect, it, vi } from "vitest";

const reply = vi.fn();
vi.mock("~/components/session/send-as-person", async (importOriginal) => ({
  ...(await importOriginal<typeof import("~/components/session/send-as-person")>()),
  useSendAsPerson: () => ({ reply, pending: false, error: undefined }),
}));

import { draftKey, useComposerDraftStore } from "~/stores/composer-drafts";
import { HomeEmptyState } from "./home-empty-state";

beforeEach(() => reply.mockReset());

it("sends each starter's request as the person's message", () => {
  const onPick = vi.fn();
  render(<HomeEmptyState sessionId="s1" threadId="t1" onPick={onPick} />);
  fireEvent.click(screen.getByRole("button", { name: "What needs me today?" }));
  fireEvent.click(screen.getByRole("button", { name: "Catch me up on Slack since yesterday" }));
  expect(reply.mock.calls).toEqual([["What needs me today?"], ["Catch me up on Slack since yesterday"]]);
  expect(onPick).toHaveBeenCalledTimes(2);
});

it("sends a complete request for the open-ended starter and leaves the message box alone", () => {
  render(<HomeEmptyState sessionId="s2" threadId="t2" />);
  expect(screen.queryByRole("button", { name: /:$/ })).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Start a task" }));
  expect(reply).toHaveBeenCalledWith("Help me start a new task. Ask me what it is.");
  expect(useComposerDraftStore.getState().byKey[draftKey("s2", "t2")]?.text ?? "").toBe("");
});
