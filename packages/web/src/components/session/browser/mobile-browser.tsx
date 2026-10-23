import { useEffect, useState, useSyncExternalStore } from "react";
import { ArrowLeft, ChevronDown, ChevronUp, Globe, Maximize2 } from "lucide-react";
import {
  Button,
  Dialog,
  DialogClose,
  DialogContent,
  DialogTitle,
  DialogTrigger,
} from "~/components/primitives";
import { useResponsiveOverlay } from "~/hooks/use-responsive-overlay";
import { BrowserPane } from "./browser-pane";
import { BrowserPreviewFeed } from "./browser-preview-feed";

const query = "(max-width: 639px)";
function subscribe(callback: () => void) {
  const media = window.matchMedia?.(query);
  media?.addEventListener("change", callback);
  return () => media?.removeEventListener("change", callback);
}
export function useMobileBrowserLayout() {
  return useSyncExternalStore(
    subscribe,
    () => window.matchMedia?.(query).matches ?? false,
    () => false,
  );
}

export function MobileBrowser({
  sessionId,
  threadId,
  working,
}: {
  sessionId: string;
  threadId?: string;
  working: boolean;
}) {
  const { open, setOpen } = useResponsiveOverlay("sm");
  const [minimized, setMinimized] = useState(!working);
  const [choice, setChoice] = useState<string>();
  useEffect(() => {
    setMinimized(!working);
  }, [working]);
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <section
        aria-label="Browser preview"
        className="mx-5 my-2 shrink-0 overflow-hidden rounded-xl border border-line bg-paper"
      >
        <div className="flex items-center gap-1 px-2">
          <DialogTrigger asChild>
            <Button
              variant="ghost"
              className="min-w-0 flex-1 justify-start"
              aria-label="Open browser"
              title="Open full browser"
            >
              <Globe className="h-4 w-4 shrink-0" aria-hidden />
              <span>{working ? "Browser working…" : "Browser"}</span>
              <Maximize2 className="ml-auto h-4 w-4 shrink-0" aria-hidden />
            </Button>
          </DialogTrigger>
          <Button
            variant="ghost"
            className="w-11 shrink-0 px-0"
            aria-label={
              minimized ? "Restore browser preview" : "Minimize browser preview"
            }
            aria-expanded={!minimized}
            title={minimized ? "Expand preview" : "Collapse preview"}
            onClick={() => setMinimized(!minimized)}
          >
            {minimized ? (
              <ChevronDown className="h-4 w-4" aria-hidden />
            ) : (
              <ChevronUp className="h-4 w-4" aria-hidden />
            )}
          </Button>
        </div>
        {!minimized && !open && (
          <div className="flex h-44 flex-col">
            <BrowserPreviewFeed
              sessionId={sessionId}
              threadId={threadId}
              working={working}
              choice={choice}
              onChoose={setChoice}
            />
          </div>
        )}
      </section>
      <DialogContent
        hideClose
        aria-describedby={undefined}
        onEscapeKeyDown={(event) => {
          if (
            event.target instanceof HTMLTextAreaElement &&
            event.target.getAttribute("aria-label") === "Browser page input"
          )
            event.preventDefault();
        }}
        className="inset-0 flex h-dvh max-h-dvh w-full max-w-none translate-x-0 translate-y-0 flex-col gap-0 overflow-hidden rounded-none border-0 p-0 pt-[env(safe-area-inset-top)] pb-[env(safe-area-inset-bottom)]"
      >
        <header className="flex shrink-0 items-center gap-3 border-b border-line px-2">
          <DialogClose asChild>
            <Button variant="ghost" aria-label="Back to chat">
              <ArrowLeft className="h-4 w-4" aria-hidden />
              Chat
            </Button>
          </DialogClose>
          <DialogTitle className="text-sm font-medium">Browser</DialogTitle>
        </header>
        <div className="flex min-h-0 flex-1 flex-col overflow-y-auto">
          <BrowserPane sessionId={sessionId} compact />
        </div>
      </DialogContent>
    </Dialog>
  );
}
