// @vitest-environment jsdom
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { useSessionStream, useStreamStore } from "~/stores/stream";
import { QuickReplies } from "./quick-replies";

const send = vi.hoisted(() => vi.fn());
vi.mock("~/api/queries", () => ({ useSendPrompt: () => ({ mutateAsync: send, isPending: false }) }));
vi.mock("./message-item", () => ({ messageCopyText: (message: { content: string }) => message.content }));

afterEach(() => { useStreamStore.getState().remove("s1"); send.mockReset(); });

function Thread() {
  const { messages } = useSessionStream("s1");
  return <QuickReplies sessionId="s1" threadId="t1" messages={messages} />;
}

it("restores the question and shows the send error so a quick reply can be retried", async () => {
  useStreamStore.getState().setThreadMessages("s1", "t1", [{ id: "question", sessionId: "s1", threadId: "t1",
    role: "assistant", content: "Should I continue?", parts: [{ kind: "text", text: "Should I continue?" }],
    createdAt: 1, completed: true }]);
  send.mockRejectedValueOnce(new Error("Connection lost")).mockResolvedValueOnce({ messageId: "queue-1" });
  render(<Thread />);
  fireEvent.click(screen.getByRole("button", { name: "Yes" }));
  expect((await screen.findByRole("alert")).textContent).toContain("Connection lost");
  expect(useStreamStore.getState().bySession.s1.messages.map((message) => message.id)).toEqual(["question"]);
  fireEvent.click(screen.getByRole("button", { name: "Yes" }));
  await waitFor(() => expect(send).toHaveBeenCalledTimes(2));
  await waitFor(() => expect(useStreamStore.getState().bySession.s1.messages.at(-1)?.queueItemId).toBe("queue-1"));
  expect(screen.queryByRole("group")).toBeNull();
});
