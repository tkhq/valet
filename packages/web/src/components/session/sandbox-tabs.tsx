import { useCallback, useEffect, useRef, useState } from "react";
import type { SandboxProfile } from "@valet/api/wire";
import { useSandboxJwt } from "~/api/queries";
import { Button, Spinner } from "~/components/primitives";
import { SandboxChip } from "~/components/session/session-header";
import { cn } from "~/lib/cn";

export type SandboxTabId = "chat" | "terminal" | "vscode";

const TABS: { id: SandboxTabId; label: string }[] = [
  { id: "chat", label: "Chat" },
  { id: "terminal", label: "Terminal" },
  { id: "vscode", label: "VS Code" },
];

/** `terminal`/`vscode` -> the gateway path segment those tabs proxy to
 * (`/api/sessions/:id/gateway/{ttyd|vscode}/…`, Task 6). */
const GATEWAY_PATH: Record<Exclude<SandboxTabId, "chat">, string> = {
  terminal: "ttyd",
  vscode: "vscode",
};

/**
 * Chat / Terminal / VS Code tab switch for "full"-profile sessions (sandbox
 * auth gateway plan, Task 7). Renders nothing for "headless" sessions — no
 * empty tab bar. The chat tab renders no body of its own (the caller keeps
 * showing `MessageList`/`Composer` for it); non-chat tabs render the
 * gateway iframe pane below the tab bar, gated on `sandbox.state ===
 * "ready"` — that's the only state under which `Session.attachment.current()`
 * (and therefore `gatewayEndpoint()`) is non-null on the server, see
 * `packages/engine/src/sandbox/attachment.ts`.
 */
export interface SandboxTabsProps {
  sessionId: string;
  profile: SandboxProfile;
  activeTab: SandboxTabId;
  onTabChange: (tab: SandboxTabId) => void;
  sandbox?: { state: string; epoch: number };
}

export function SandboxTabs({
  sessionId,
  profile,
  activeTab,
  onTabChange,
  sandbox,
}: SandboxTabsProps) {
  if (profile !== "full") return null;

  return (
    <div className="flex flex-1 min-h-0 flex-col">
      <div role="tablist" aria-label="Session view" className="flex items-center gap-1 border-b border-line px-4">
        {TABS.map((t) => (
          <button
            key={t.id}
            type="button"
            role="tab"
            aria-selected={activeTab === t.id}
            onClick={() => onTabChange(t.id)}
            className={cn(
              "px-2.5 py-2 text-xs font-medium border-b-2 -mb-px transition-colors",
              activeTab === t.id
                ? "border-moss text-ink"
                : "border-transparent text-muted hover:text-ink",
            )}
          >
            {t.label}
          </button>
        ))}
      </div>
      {activeTab !== "chat" && (
        <GatewayPane sessionId={sessionId} tab={activeTab} sandbox={sandbox} />
      )}
    </div>
  );
}

/**
 * The iframe pane for a non-chat tab. Precedes the iframe render with a
 * same-origin `fetch` status check against the gateway URL: the iframe
 * itself has no way to report the HTTP status of what it loaded (a 401 vs.
 * a 502 both just "load" a same-origin error document), but the precheck
 * lets us tell them apart — 401 triggers a single silent re-mint + retry,
 * 502/other triggers the error panel.
 */
function GatewayPane({
  sessionId,
  tab,
  sandbox,
}: {
  sessionId: string;
  tab: Exclude<SandboxTabId, "chat">;
  sandbox?: { state: string; epoch: number };
}) {
  const jwt = useSandboxJwt(sessionId);
  const [src, setSrc] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const remintedRef = useRef(false);
  // Monotonic request generation, bumped on every fresh (non-remint) load.
  // A tab switch mid-flight starts a new generation; when the stale
  // request's mint/fetch eventually resolves it no-ops instead of
  // clobbering the newer tab's state with the old tab's result.
  const genRef = useRef(0);
  const ready = sandbox?.state === "ready";

  const load = useCallback(
    async (isRemint = false) => {
      const gen = isRemint ? genRef.current : ++genRef.current;
      if (!isRemint) {
        remintedRef.current = false;
        setSrc(null);
      }
      setError(null);
      try {
        const { token } = await jwt.mutateAsync();
        if (genRef.current !== gen) return; // superseded by a newer load
        const url = `/api/sessions/${encodeURIComponent(sessionId)}/gateway/${GATEWAY_PATH[tab]}/?token=${encodeURIComponent(token)}`;
        const res = await fetch(url, { method: "GET" });
        if (genRef.current !== gen) return; // superseded by a newer load
        if (res.status === 401 && !remintedRef.current) {
          remintedRef.current = true;
          await load(true);
          return;
        }
        if (res.status === 409) {
          setError("Sandbox isn't ready yet.");
          return;
        }
        if (!res.ok) {
          setError("Couldn't reach the sandbox gateway.");
          return;
        }
        remintedRef.current = false;
        setSrc(url);
      } catch {
        if (genRef.current !== gen) return;
        setError("Couldn't reach the sandbox gateway.");
      }
    },
    [jwt, sessionId, tab],
  );

  useEffect(() => {
    setSrc(null);
    setError(null);
    remintedRef.current = false;
    if (ready) void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab, ready, sessionId]);

  if (!ready) {
    return (
      <div className="flex-1 grid place-items-center gap-2 text-sm text-muted">
        <Spinner />
        <div className="inline-flex items-center gap-1.5">
          starting workspace…
          <SandboxChip sandbox={sandbox} />
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex-1 grid place-items-center gap-2 p-8 text-center text-sm text-danger-500">
        {error}
        <Button variant="ghost" size="sm" onClick={() => void load()}>
          Retry
        </Button>
      </div>
    );
  }

  if (!src) {
    return (
      <div className="flex-1 grid place-items-center text-sm text-muted">
        <Spinner />
      </div>
    );
  }

  const title = tab === "terminal" ? "Terminal" : "VS Code";
  return (
    <iframe
      title={title}
      src={src}
      className="flex-1 border-0"
      onError={() => setError("Couldn't reach the sandbox gateway.")}
    />
  );
}
