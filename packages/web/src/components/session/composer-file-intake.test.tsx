// @vitest-environment jsdom
/**
 * File intake in the composer: a non-image file becomes a chip, uploads to
 * the sandbox, blocks Send until the upload finishes, and the send request
 * carries the attachment refs.
 *
 * The upload hook is mocked — route behaviour is covered by the api's
 * sandbox-file-upload integration tests.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useComposerPrefillStore } from "~/stores/composer-prefill";
import type { ComposerFile } from "./composer-files";

const sendMutateAsync = vi.fn().mockResolvedValue({ messageId: "q-1", threadId: "thread-1" });
const addUserMessage = vi.fn(() => "user-opt-1");
const setMessageQueueItemId = vi.fn();

// Deferred upload resolution so tests can observe the "uploading" state.
let resolveUpload: ((file: ComposerFile) => void) | undefined;
const uploadFile = vi.fn(
  (file: ComposerFile) =>
    new Promise<ComposerFile>((resolve) => {
      resolveUpload = (f) => resolve({ ...f, attachmentRef: `att_${f.name}` });
      resolveUpload(file);
    }),
);

vi.mock("~/api/queries", async (importOriginal) => {
  const actual = await importOriginal<typeof import("~/api/queries")>();
  return {
    ...actual,
    useSendPrompt: () => ({ isPending: false, mutateAsync: sendMutateAsync }),
    useAbortThread: () => ({ isPending: false, mutateAsync: vi.fn(), mutate: vi.fn() }),
  };
});

vi.mock("~/stores/stream", async (importOriginal) => {
  const actual = await importOriginal<typeof import("~/stores/stream")>();
  return {
    ...actual,
    useStreamStore: (selector: (s: Record<string, unknown>) => unknown) =>
      selector({ addUserMessage, setMessageQueueItemId }),
    useQueueStateForThread: () => undefined,
  };
});

vi.mock("~/hooks/use-commands", () => ({
  useCommands: () => ({ data: { commands: [] } }),
}));

vi.mock("~/hooks/use-file-upload", () => ({
  useFileUpload: () => ({ uploadFile }),
}));

import { Composer } from "./composer";

function renderComposer() {
  const queryClient = new QueryClient();
  return render(
    <QueryClientProvider client={queryClient}>
      <Composer sessionId="orchestrator:user-1" threadId="thread-1" agentStatus="idle" />
    </QueryClientProvider>,
  );
}

function textFile(name: string): File {
  return new File(["file-bytes"], name, { type: "text/plain" });
}

function pasteFiles(target: Element, files: File[]) {
  const event = new Event("paste", { bubbles: true, cancelable: true });
  Object.defineProperty(event, "clipboardData", {
    value: {
      items: files.map((file) => ({ kind: "file", type: file.type, getAsFile: () => file })),
    },
  });
  fireEvent(target, event);
}

beforeEach(() => {
  useComposerPrefillStore.setState({ text: null });
  sendMutateAsync.mockClear();
  addUserMessage.mockClear();
  uploadFile.mockClear();
});

describe("Composer — file intake", () => {
  it("attaches a pasted text file as a chip and uploads it", async () => {
    renderComposer();
    pasteFiles(screen.getByPlaceholderText(/Send a message/i), [textFile("notes.txt")]);
    await waitFor(() => {
      expect(screen.getByLabelText("Attached files").textContent).toContain("notes.txt");
    });
    expect(uploadFile).toHaveBeenCalledTimes(1);
  });

  it("sends the attachment refs and clears the chips", async () => {
    renderComposer();
    const textarea = screen.getByPlaceholderText(/Send a message/i);
    pasteFiles(textarea, [textFile("notes.txt")]);
    // Wait for the upload to resolve (chip shows the success check).
    await waitFor(() => expect(screen.getByText("✓")).toBeDefined());
    fireEvent.change(textarea, { target: { value: "read this file" } });
    fireEvent.click(screen.getByRole("button", { name: /send/i }));
    await waitFor(() => expect(sendMutateAsync).toHaveBeenCalled());
    const arg = sendMutateAsync.mock.calls[0][0] as {
      text: string;
      fileRefs?: Array<{ ref: string }>;
    };
    expect(arg.fileRefs).toEqual([{ ref: "att_notes.txt" }]);
    expect(screen.queryByLabelText("Attached files")).toBeNull();
  });

  it("removes a chip on request without sending its ref", async () => {
    renderComposer();
    const textarea = screen.getByPlaceholderText(/Send a message/i);
    pasteFiles(textarea, [textFile("notes.txt")]);
    await waitFor(() => expect(screen.getByText("✓")).toBeDefined());
    fireEvent.click(screen.getByRole("button", { name: "Remove file" }));
    expect(screen.queryByLabelText("Attached files")).toBeNull();
    fireEvent.change(textarea, { target: { value: "no attachments now" } });
    fireEvent.click(screen.getByRole("button", { name: /send/i }));
    await waitFor(() => expect(sendMutateAsync).toHaveBeenCalled());
    const arg = sendMutateAsync.mock.calls[0][0] as { fileRefs?: Array<{ ref: string }> };
    expect(arg.fileRefs).toBeUndefined();
  });
});
