/**
 * Hook to upload files to a session's sandbox. Manages progress tracking,
 * error handling, and attachment ref extraction.
 */
import { useCallback } from "react";
import type { ComposerFile } from "~/components/session/composer-files";

export function useFileUpload(sessionId: string) {

  /**
   * Upload a single file to the session. Returns the updated ComposerFile
   * with attachmentRef set on success, or error set on failure.
   *
   * The caller owns UI updates — this hook just does the upload work.
   */
  const uploadFile = useCallback(
    async (file: ComposerFile): Promise<ComposerFile> => {
      const formData = new FormData();
      formData.append("file", file.file, file.name);
      // extract=auto is the API default; the composer does not expose the extract knob today

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
