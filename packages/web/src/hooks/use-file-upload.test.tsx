// @vitest-environment jsdom
import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useStreamStore } from "~/stores/stream";
import { useFileUpload, waitForSandboxReady } from "./use-file-upload";
import type { ComposerFile } from "~/components/session/composer-files";

const sessionId = "session-1";
const file: ComposerFile = {
  id: "file-1",
  name: "notes.txt",
  bytes: 5,
  file: new File(["hello"], "notes.txt"),
};

function status(state: string, epoch = 1) {
  useStreamStore.setState((store) => ({
    bySession: { ...store.bySession, [sessionId]: { ...store.bySession[sessionId], sandbox: { state, epoch } } },
  }));
}

beforeEach(() => {
  useStreamStore.setState({ bySession: {} });
  vi.restoreAllMocks();
});

describe("useFileUpload sandbox wake", () => {
  it("waits for ready and retries the same file once", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(new Response(JSON.stringify({ wake: true }), { status: 409 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ attachmentRef: "att_1" }), { status: 200 }));
    const { result } = renderHook(() => useFileUpload(sessionId));
    const updates: Array<Partial<ComposerFile>> = [];
    const upload = result.current.uploadFile(file, undefined, (update) => updates.push(update));
    await vi.waitFor(() => expect(updates).toEqual([{ waitingForSandbox: true }]));
    act(() => status("provisioning"));
    act(() => status("ready"));
    await expect(upload).resolves.toMatchObject({ attachmentRef: "att_1", file: file.file, name: "notes.txt" });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(updates).toEqual([{ waitingForSandbox: true }, { waitingForSandbox: undefined }]);
  });

  it("stops on an authoritative sandbox error", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ wake: true }), { status: 409 }),
    );
    const { result } = renderHook(() => useFileUpload(sessionId));
    const upload = result.current.uploadFile(file);
    act(() => status("error"));
    await expect(upload).resolves.toMatchObject({ error: expect.stringContaining("did not start") });
  });

  it("cancels a waiter when its file is deleted", async () => {
    const controller = new AbortController();
    const waiting = waitForSandboxReady(sessionId, controller.signal);
    controller.abort(new Error("deleted"));
    await expect(waiting).rejects.toThrow("deleted");
    act(() => status("ready"));
  });
});

it("times out when no terminal sandbox status arrives", async () => {
  vi.useFakeTimers();
  const waiting = expect(waitForSandboxReady(sessionId, new AbortController().signal))
    .rejects.toThrow("did not become ready in time");
  await vi.advanceTimersByTimeAsync(60_000);
  await waiting;
  vi.useRealTimers();
});
