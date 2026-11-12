// @vitest-environment jsdom
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, expect, it, vi } from "vitest";

const reply = vi.fn();
vi.mock("~/components/session/send-as-person", async (importOriginal) => ({
  ...(await importOriginal<typeof import("~/components/session/send-as-person")>()),
  useSendAsPerson: () => ({ reply, pending: false, error: undefined }),
}));

import { draftKey, useComposerDraftStore } from "~/stores/composer-drafts";
import { HomeEmptyState } from "./home-empty-state";

beforeEach(() => { reply.mockReset(); reply.mockResolvedValue(true); });

it("sends each starter's request as the person's message", async () => {
  const onPick = vi.fn();
  render(<HomeEmptyState sessionId="s1" threadId="t1" onPick={onPick} />);
  fireEvent.click(screen.getByRole("button", { name: "What needs me today?" }));
  fireEvent.click(screen.getByRole("button", { name: "Catch me up on Slack since yesterday" }));
  expect(reply.mock.calls).toEqual([["What needs me today?"], ["Catch me up on Slack since yesterday"]]);
  await waitFor(() => expect(onPick).toHaveBeenCalledTimes(2));
});

it("keeps the idle view up when a send fails, so its error stays visible", async () => {
  reply.mockResolvedValue(false);
  const onPick = vi.fn();
  render(<HomeEmptyState sessionId="s4" threadId="t4" onPick={onPick} />);
  fireEvent.click(screen.getByRole("button", { name: "What needs me today?" }));
  await waitFor(() => expect(reply).toHaveBeenCalled());
  await Promise.resolve();
  expect(onPick).not.toHaveBeenCalled();
});

it("sends a complete request for the open-ended starter and leaves the message box alone", () => {
  render(<HomeEmptyState sessionId="s2" threadId="t2" />);
  expect(screen.queryByRole("button", { name: /:$/ })).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Start a task" }));
  expect(reply).toHaveBeenCalledWith("Help me start a new task. Ask me what it is.");
  expect(useComposerDraftStore.getState().byKey[draftKey("s2", "t2")]?.text ?? "").toBe("");
});
