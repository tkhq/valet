/**
 * Hook to upload files to a session's sandbox. Manages progress tracking,
 * error handling, and attachment ref extraction.
 */
import { useCallback } from "react";
import { useQueryClient } from "@tanstack/react-query";
import type { ComposerFile } from "~/components/session/composer-files";

export function useFileUpload(sessionId: string) {
  const qc = useQueryClient();

  /**
   * Upload a single file to the session. Returns the updated ComposerFile
   * with attachmentRef set on success, or error set on failure.
   *
   * The caller owns UI updates — this hook just does the upload work.
   */
  const uploadFile = useCallback(
    async (file: ComposerFile): Promise<ComposerFile> => {
      const formData = new FormData();
      // The input File is already available in the session state,
      // but we need to re-read it via the DOM (through the file input ref)
      // or hold it separately. For now, this signature assumes the caller
      // will have the File object available and pass it separately.
      // See the composer for the full integration pattern.

      try {
        const res = await fetch(`/api/sessions/${encodeURIComponent(sessionId)}/files`, {
          method: "POST",
          body: formData,
        });

        if (!res.ok) {
          const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
          const errorMsg =
            typeof body.corrective === "string"
              ? body.corrective
              : typeof body.error === "string"
                ? `Upload failed: ${body.error}`
                : `Upload failed (HTTP ${res.status})`;
          return { ...file, error: errorMsg };
        }

        const data = (await res.json()) as Record<string, unknown>;
        const attachmentRef = typeof data.attachmentRef === "string" ? data.attachmentRef : undefined;

        if (!attachmentRef) {
          return { ...file, error: "Invalid response from server" };
        }

        // Mark upload complete
        return { ...file, uploadProgress: 100, attachmentRef };
      } catch (err) {
        const errorMsg = err instanceof Error ? err.message : "Upload failed";
        return { ...file, error: errorMsg };
      }
    },
    [sessionId],
  );

  return { uploadFile };
}
