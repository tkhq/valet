import { useState } from "react";
import { useBrowserFrame, useBrowserStatus } from "~/api/browser";
import { Button, Spinner } from "~/components/primitives";

export function BrowserPreviewFeed({
  sessionId,
  threadId,
  working,
  choice,
  onChoose,
}: {
  sessionId: string;
  threadId?: string;
  working: boolean;
  choice?: string;
  onChoose: (id: string) => void;
}) {
  const query = useBrowserStatus(sessionId);
  const [decodeError, setDecodeError] = useState(false);
  const data = query.data;
  const runtime = data?.status;
  const privateMode = !!runtime?.control?.privateMode;
  const selected =
    runtime?.tabs.find((tab) => tab.id === choice) ??
    runtime?.tabs.find(
      (tab) =>
        tab.id === runtime.selectedTabId && tab.ownerThreadId === threadId,
    ) ??
    runtime?.tabs.find((tab) => !!threadId && tab.ownerThreadId === threadId) ??
    runtime?.tabs.find((tab) => tab.id === runtime.selectedTabId) ??
    runtime?.tabs[0];
  const dialog = !!runtime?.dialogs?.length;
  const statusError = query.isError || !!data?.error;
  const allowed =
    !statusError &&
    !!data?.enabled &&
    !!data.settings.enabled &&
    runtime?.state === "ready" &&
    !!runtime.capabilities.viewer?.available &&
    !privateMode &&
    !dialog;
  const live = useBrowserFrame(
    sessionId,
    runtime?.runtimeId,
    selected?.id,
    allowed,
    selected?.documentId,
  );
  const error = statusError
    ? "Browser status is unavailable. Retry the preview or open the Browser view."
    : (live.error ??
      (decodeError
        ? "The browser image could not load. Retry the preview."
        : null));
  const message =
    error ??
    (query.isPending
      ? "Connecting to browser…"
      : privateMode
        ? "Private sign-in is hidden. Open the Browser view to continue."
        : !data?.enabled || !data.settings.enabled
          ? "Browser viewing is disabled. Open the Browser view to check access."
          : dialog
            ? "A browser dialog needs attention. Open the Browser view to respond."
            : runtime?.state !== "ready"
              ? "The browser is not running. Open the Browser view to start or reconnect."
              : !runtime.capabilities.viewer?.available
                ? "Live preview is unavailable. Open the Browser view for details."
                : !selected
                  ? "Waiting for a browser page."
                  : !live.visible
                    ? "Preview paused while this window is hidden."
                    : !live.frame
                      ? "Loading live preview…"
                      : null);
  const showMetadata = allowed && !error;

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {showMetadata && selected && (
        <div className="flex shrink-0 items-center gap-2 border-y border-line px-3 py-1.5">
          <select
            aria-label="Preview page"
            value={selected.id}
            onChange={(event) => {
              onChoose(event.target.value);
              setDecodeError(false);
            }}
            className="min-w-0 flex-1 rounded bg-paper py-1 text-xs text-ink focus-visible:outline-moss"
          >
            {runtime?.tabs.map((tab) => (
              <option key={tab.id} value={tab.id}>
                {tab.title || tab.url || "Untitled page"}
              </option>
            ))}
          </select>
          <span className="shrink-0 text-[10px] text-muted">
            {runtime?.control ? "Paused" : working ? "Working" : "Live"}
          </span>
        </div>
      )}
      <div className="relative flex min-h-0 flex-1 items-center justify-center overflow-auto bg-ink-wash">
        {message ? (
          <div
            className="m-auto flex flex-col items-center gap-2 p-4 text-center text-xs text-muted"
            role="status"
          >
            {query.isPending && <Spinner />}
            <p>{message}</p>
            {error && (
              <Button
                variant="secondary"
                size="sm"
                onClick={() => {
                  setDecodeError(false);
                  live.retry();
                  void query.refetch();
                }}
              >
                Retry preview
              </Button>
            )}
          </div>
        ) : (
          <img
            src={live.frame?.url}
            alt="Live browser page"
            draggable={false}
            className="h-full w-full select-none object-contain"
            onError={() => setDecodeError(true)}
          />
        )}
      </div>
      {showMetadata && selected && (
        <p
          className="shrink-0 truncate px-3 py-1 text-[10px] text-muted"
          title={selected.url}
        >
          {selected.url}
        </p>
      )}
    </div>
  );
}
