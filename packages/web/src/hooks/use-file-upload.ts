/** Upload files and retry once after an authoritative sandbox-ready event. */
import { useCallback } from "react";
import { useStreamStore } from "~/stores/stream";
import type { ComposerFile } from "~/components/session/composer-files";

const UPLOAD_TIMEOUT_MS = 5 * 60 * 1000;
const WAKE_TIMEOUT_MS = 60 * 1000;
type SandboxState = { state: string; epoch: number } | undefined;
type UploadUpdate = (update: Partial<ComposerFile>) => void;

function uploadError(body: Record<string, unknown>, status: number): string {
  return typeof body.corrective === "string"
    ? body.corrective
    : typeof body.error === "string"
      ? `Upload failed: ${body.error}`
      : `Upload failed (HTTP ${status})`;
}

/** Wait for the existing status stream to report ready or a terminal state. */
export function waitForSandboxReady(
  sessionId: string,
  signal: AbortSignal,
  observed?: SandboxState,
): Promise<void> {
  return new Promise((resolve, reject) => {
    let unsubscribe = () => {};
    let timer: ReturnType<typeof setTimeout> | undefined;
    let settled = false;
    const cleanup = () => {
      if (timer) clearTimeout(timer);
      unsubscribe();
      signal.removeEventListener("abort", onAbort);
    };
    const settle = (sandbox: SandboxState): boolean => {
      if (settled) return true;
      if (sandbox?.state === "ready" && sandbox !== observed) {
        settled = true;
        cleanup();
        resolve();
        return true;
      }
      if (sandbox?.state === "error" || sandbox?.state === "released") {
        settled = true;
        cleanup();
        reject(new Error("The sandbox did not start. Retry the upload after the sandbox recovers."));
        return true;
      }
      return false;
    };
    const onAbort = () => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(signal.reason instanceof Error ? signal.reason : new Error("Upload canceled"));
    };
    if (settle(useStreamStore.getState().bySession[sessionId]?.sandbox)) return;
    unsubscribe = useStreamStore.subscribe((state) => {
      settle(state.bySession[sessionId]?.sandbox);
    });
    // Close the read-before-subscribe race if ready landed between both reads.
    if (settle(useStreamStore.getState().bySession[sessionId]?.sandbox)) return;
    timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(new Error("The sandbox did not become ready in time. Retry the upload."));
    }, WAKE_TIMEOUT_MS);
    signal.addEventListener("abort", onAbort, { once: true });
    if (signal.aborted) onAbort();
  });
}

export function useFileUpload(sessionId: string) {
  const uploadFile = useCallback(
    async (file: ComposerFile, signal?: AbortSignal, onUpdate?: UploadUpdate): Promise<ComposerFile> => {
      const timeout = AbortSignal.timeout(UPLOAD_TIMEOUT_MS);
      const requestSignal = signal ? AbortSignal.any([signal, timeout]) : timeout;
      try {
        for (let attempt = 0; attempt < 2; attempt += 1) {
          const formData = new FormData();
          formData.append("file", file.file, file.name);
          const res = await fetch(`/api/sessions/${encodeURIComponent(sessionId)}/files`, {
            method: "POST",
            body: formData,
            signal: requestSignal,
          });
          const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
          if (res.status === 409 && body.wake === true && attempt === 0) {
            onUpdate?.({ waitingForSandbox: true });
            const observed = useStreamStore.getState().bySession[sessionId]?.sandbox;
            await waitForSandboxReady(sessionId, requestSignal, observed);
            onUpdate?.({ waitingForSandbox: undefined });
            continue;
          }
          if (!res.ok) return { ...file, waitingForSandbox: undefined, error: uploadError(body, res.status) };
          const attachmentRef = typeof body.attachmentRef === "string" ? body.attachmentRef : undefined;
          return attachmentRef
            ? { ...file, waitingForSandbox: undefined, attachmentRef }
            : { ...file, waitingForSandbox: undefined, error: "The server response had no attachment ref. Try uploading again." };
        }
        return { ...file, waitingForSandbox: undefined, error: "The sandbox is still waking. Retry the upload." };
      } catch (err) {
        const error = err instanceof Error ? err.message : "Upload failed";
        return { ...file, waitingForSandbox: undefined, error };
      }
    },
    [sessionId],
  );
  return { uploadFile };
}
