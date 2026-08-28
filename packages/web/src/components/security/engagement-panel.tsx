import { useCallback, useState, type CSSProperties, type ReactNode } from "react";
import { useEngagement, useSecurityFindings, flattenFindings } from "~/api/security";
import { useMe, useTeams } from "~/api/settings";
import { useSession } from "~/api/queries";
import { useStreamStore } from "~/stores/stream";
import { Spinner } from "~/components/primitives";
import { cn } from "~/lib/cn";
import { CellRail } from "./cell-rail";
import { FindingsReview } from "./findings-review";
import { ManifestCard } from "./manifest-card";

/**
 * The security engagement panel (valet-security design §engagement panel):
 * manifest card once closed, the cell rail, and the findings review. No
 * `host_event` wire events on this branch, so the engagement polls every
 * 5s while it runs and the findings review polls on the same cadence.
 */
export function EngagementPanel({
  sessionId,
  initialFindingId,
  onOpenChild,
}: {
  sessionId: string;
  /** From the `?finding=` permalink param. */
  initialFindingId?: string;
  /** Open a cell's persona child as the `?child=` slide-over instead of
   * navigating to its standalone page. */
  onOpenChild?: (childId: string) => void;
}) {
  // Poll until the engagement is terminal — NOT only while "running". Cells
  // are materialized at sec_start, when the status flips planning → running;
  // gating the poll on status === "running" deadlocks, because the query
  // that would observe that flip is the one told not to refetch during
  // planning. A missing status (first load) polls too.
  const engagementQ = useEngagement(sessionId, {
    refetchInterval: (query) => {
      const status = query.state.data?.engagement.status;
      return status === "completed" || status === "failed" ? false : 5_000;
    },
  });

  // Admin gating mirrors the session header's rule: personal sessions are
  // administered by their owner (who is the only viewer), team sessions by
  // team admins and org admins. The routes enforce the real check; this
  // only hides buttons that would 403.
  const session = useSession(sessionId);
  const me = useMe();
  const teams = useTeams();
  const owner = session.data?.owner;
  const teamId = owner?.type === "team" ? owner.id : null;
  const team = teamId !== null ? teams.data?.teams.find((t) => t.id === teamId) : undefined;
  const canAdminister =
    teamId === null || team?.callerRole === "admin" || me.data?.orgRole === "admin";

  // The manifest card derives its tallies from the full (unfiltered)
  // findings set — the sec_close manifest is not on any GET route. Only
  // fetched once the engagement is closed.
  const closed =
    engagementQ.data?.engagement.status === "completed" ||
    engagementQ.data?.engagement.status === "failed";
  const allFindingsQ = useSecurityFindings(closed ? sessionId : "", {});

  if (engagementQ.isPending) {
    return (
      <div className="p-4 text-xs text-muted">
        <Spinner /> Loading engagement…
      </div>
    );
  }
  if (engagementQ.isError || !engagementQ.data) {
    return (
      <div className="p-4 text-xs text-danger-600">
        Failed to load the security engagement. Reload the page to retry.
      </div>
    );
  }

  const { engagement, cells } = engagementQ.data;
  return (
    <div className="flex flex-col min-h-0">
      {closed && (engagement.status === "completed" || engagement.status === "failed") && (
        <ManifestCard
          cells={cells}
          findings={flattenFindings(allFindingsQ.data?.pages)}
          status={engagement.status}
        />
      )}
      <div className="border-b border-line px-4 py-2 text-xs text-muted">
        <span className="font-mono text-ink">{engagement.repoFullName}</span>
        {engagement.repoRef !== "" && (
          <span className="font-mono"> @ {engagement.repoRef.slice(0, 12)}</span>
        )}
        <span> · {engagement.status}</span>
      </div>
      <CellRail cells={cells} onOpenChild={onOpenChild} />
      <div className="border-t border-line" />
      <FindingsReview
        sessionId={sessionId}
        engagement={engagement}
        cells={cells}
        canAdminister={canAdminister}
        initialFindingId={initialFindingId}
        polling={engagement.status === "running"}
        onOpenChild={onOpenChild}
      />
    </div>
  );
}

type MobilePane = "chat" | "panel";

// The security panel's resizable width (desktop only; below `md` it is a
// full-width tab). Applied through a CSS variable so a `md:` Tailwind class
// gates it to the side-by-side layout — no JS media query needed.
const PANEL_WIDTH_KEY = "valet:sec-panel-width";
const PANEL_MIN = 320;
const PANEL_MAX = 900;
const PANEL_DEFAULT = 480; // 30rem, the previous fixed width
const PANEL_STEP = 24; // keyboard nudge

const clampPanelWidth = (n: number) => Math.min(PANEL_MAX, Math.max(PANEL_MIN, Math.round(n)));

/** Panel width in px, persisted to localStorage and clamped. */
function usePanelWidth(): readonly [number, (n: number) => void] {
  const [width, setWidth] = useState<number>(() => {
    try {
      const raw = window.localStorage.getItem(PANEL_WIDTH_KEY);
      const n = raw ? Number.parseInt(raw, 10) : Number.NaN;
      return Number.isFinite(n) ? clampPanelWidth(n) : PANEL_DEFAULT;
    } catch {
      return PANEL_DEFAULT;
    }
  });
  const set = useCallback((n: number) => {
    const c = clampPanelWidth(n);
    setWidth(c);
    try {
      window.localStorage.setItem(PANEL_WIDTH_KEY, String(c));
    } catch {
      // A storage failure (private mode) just loses persistence, not the resize.
    }
  }, []);
  return [width, set] as const;
}

/**
 * Layout for `kind='security'` sessions: chat and panel side by side from
 * `md` up; below `md`, a Chat | Panel toggle — the chat pane holds the
 * decision gates, so the panel must never cover it without a way back
 * (spec §engagement panel). The Chat tab shows a dot while a gate is
 * pending anywhere in the session, from the same stream-store slice the
 * gate cards render from.
 */
export function SecuritySessionLayout({
  sessionId,
  initialFindingId,
  chat,
  onOpenChild,
}: {
  sessionId: string;
  initialFindingId?: string;
  /** The session view element — rendered once, shown/hidden responsively. */
  chat: ReactNode;
  /** Open a persona child as the `?child=` slide-over (threaded to the rail). */
  onOpenChild?: (childId: string) => void;
}) {
  const [pane, setPane] = useState<MobilePane>("chat");
  const [panelWidth, setPanelWidth] = usePanelWidth();
  const gatePending = useStreamStore(
    (s) => Object.keys(s.bySession[sessionId]?.pendingGates ?? {}).length > 0,
  );

  // Drag the divider: moving LEFT widens the (right) panel, so the delta is
  // start − current. Listeners live on window so a fast drag off the 4px
  // handle keeps tracking; the cursor/select overrides make the whole page
  // feel like a resize until pointerup.
  const startDrag = (e: React.PointerEvent) => {
    e.preventDefault();
    const startX = e.clientX;
    const startWidth = panelWidth;
    const onMove = (ev: PointerEvent) => setPanelWidth(startWidth + (startX - ev.clientX));
    const onUp = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      document.body.style.removeProperty("cursor");
      document.body.style.removeProperty("user-select");
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
  };
  const onHandleKey = (e: React.KeyboardEvent) => {
    if (e.key === "ArrowLeft") {
      e.preventDefault();
      setPanelWidth(panelWidth + PANEL_STEP);
    } else if (e.key === "ArrowRight") {
      e.preventDefault();
      setPanelWidth(panelWidth - PANEL_STEP);
    }
  };

  return (
    <div className="flex-1 flex flex-col min-h-0">
      <div className="md:hidden flex border-b border-line" role="tablist" aria-label="Session panes">
        <MobileTab
          label="Chat"
          active={pane === "chat"}
          dot={gatePending}
          onSelect={() => setPane("chat")}
        />
        <MobileTab label="Panel" active={pane === "panel"} onSelect={() => setPane("panel")} />
      </div>
      <div
        className="flex-1 flex min-h-0"
        style={{ "--sec-panel-w": `${panelWidth}px` } as CSSProperties}
      >
        <div
          className={cn(
            "flex-1 min-w-0 flex-col min-h-0",
            pane === "chat" ? "flex" : "hidden md:flex",
          )}
        >
          {chat}
        </div>
        {/* Resize handle: a 4px hit area between the panes, desktop only. */}
        <div
          role="separator"
          aria-orientation="vertical"
          aria-label="Resize security panel"
          aria-valuenow={panelWidth}
          aria-valuemin={PANEL_MIN}
          aria-valuemax={PANEL_MAX}
          tabIndex={0}
          onPointerDown={startDrag}
          onKeyDown={onHandleKey}
          className="hidden md:block w-1 shrink-0 cursor-col-resize bg-line hover:bg-moss/50 focus:bg-moss focus:outline-none"
        />
        <aside
          aria-label="Security panel"
          className={cn(
            "flex-col min-h-0 overflow-y-auto border-line",
            "md:w-[var(--sec-panel-w)] md:max-w-[70vw]",
            pane === "panel" ? "flex flex-1 md:flex-none" : "hidden md:flex",
          )}
        >
          <EngagementPanel
            sessionId={sessionId}
            initialFindingId={initialFindingId}
            onOpenChild={onOpenChild}
          />
        </aside>
      </div>
    </div>
  );
}

function MobileTab({
  label,
  active,
  dot,
  onSelect,
}: {
  label: string;
  active: boolean;
  dot?: boolean;
  onSelect: () => void;
}) {
  return (
    <button
      type="button"
      role="tab"
      aria-selected={active}
      onClick={onSelect}
      className={cn(
        "flex-1 px-3 py-2 text-xs font-medium inline-flex items-center justify-center gap-1.5",
        active ? "text-ink border-b-2 border-moss" : "text-muted",
      )}
    >
      {label}
      {dot && (
        <span
          data-testid="pending-gate-dot"
          aria-label="A decision gate is pending"
          className="h-1.5 w-1.5 rounded-full bg-amber-500"
        />
      )}
    </button>
  );
}
