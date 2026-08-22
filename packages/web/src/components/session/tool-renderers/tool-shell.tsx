import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { Check, ChevronRight, Copy } from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { cn } from "~/lib/cn";
import { getToolCardDefault, type ToolCardDefault } from "~/lib/preferences";
import { useCopyToClipboard } from "~/lib/use-copy";
import { isActiveStatus, type ToolCategory, type ToolStatus } from "./types";

/**
 * Friendly display names for tool identifiers. Unknown (plugin) tools fall
 * back to `prettyToolName`, which just de-snake_cases; the raw identifier
 * stays available as the header's `title` tooltip either way.
 */
const TOOL_LABELS: Record<string, string> = {
  bash: "shell",
  mem_write: "memory write",
  mem_patch: "memory patch",
  mem_read: "memory read",
  thread_read: "thread read",
};

export function prettyToolName(toolName: string): string {
  return TOOL_LABELS[toolName] ?? toolName.replace(/[_.-]+/g, " ");
}

/**
 * The shared chrome that wraps every tool-call rendering. Categorical color
 * lives on the left strip + status accents; the body slot is owned by the
 * specific tool renderer. While `running`, a thin scanner sweeps the header
 * — same animation regardless of tool, in the category color, signalling
 * "the agent is working" without shouting.
 */
export interface ToolShellProps {
  toolName: string;
  category: ToolCategory;
  Icon: LucideIcon;
  /** Right-of-name primary identifier (path, command excerpt, key, etc.). */
  target?: string;
  /** Far-right compact summary (e.g. "42 lines", "exit 0"). */
  summary?: string;
  status: ToolStatus;
  /** Body content; rendered inside the expandable section. */
  children: ReactNode;
}

const CATEGORY_STRIP: Record<ToolCategory, string> = {
  shell: "bg-emerald-600 dark:bg-emerald-500",
  read: "bg-sky-600 dark:bg-sky-500",
  write: "bg-emerald-600 dark:bg-emerald-500",
  edit: "bg-amber-600 dark:bg-amber-500",
  thread: "bg-violet-600 dark:bg-violet-500",
  generic: "bg-neutral-400 dark:bg-neutral-600",
};

const CATEGORY_TEXT: Record<ToolCategory, string> = {
  shell: "text-emerald-700 dark:text-emerald-400",
  read: "text-sky-700 dark:text-sky-400",
  write: "text-emerald-700 dark:text-emerald-400",
  edit: "text-amber-700 dark:text-amber-400",
  thread: "text-violet-700 dark:text-violet-400",
  generic: "text-neutral-600 dark:text-neutral-400",
};

const STATUS_DOT: Record<ToolStatus, string> = {
  streaming: "bg-current",
  running: "bg-current",
  completed: "bg-success-600 dark:bg-success-500",
  error: "bg-danger-600 dark:bg-danger-500",
};

const STATUS_LABEL: Record<ToolStatus, string> = {
  streaming: "writing",
  running: "running",
  completed: "done",
  error: "error",
};

/** Header pip label per status. Exported for tests. */
export function statusLabel(status: ToolStatus): string {
  return STATUS_LABEL[status];
}

/**
 * Resolve the mount-time expansion for a card, given the user's default
 * policy and the status the card first observed. Errors always mount
 * expanded — a user who set `always-collapsed` still needs to read the
 * message that names the corrective action.
 */
function initialExpanded(
  policy: ToolCardDefault,
  status: ToolStatus,
): boolean {
  if (status === "error") return true;
  if (policy === "always-expanded") return true;
  if (policy === "always-collapsed") return false;
  // `smart`: running expanded, completed collapsed at mount.
  return status !== "completed";
}

export function ToolShell({
  toolName,
  category,
  Icon,
  target,
  summary,
  status,
  children,
}: ToolShellProps) {
  // The user's default policy is read once at mount. A live preference
  // change never rewrites an already-mounted card — the Chat density
  // toggle on /settings/appearance takes effect on the next tool card
  // mount, which matches how V1's `thread-sidebar-collapsed` behaves and
  // keeps this effect free of listener plumbing.
  const [policy] = useState<ToolCardDefault>(() => getToolCardDefault());
  const [expanded, setExpanded] = useState<boolean>(() =>
    initialExpanded(policy, status),
  );

  // Auto-collapse-on-complete respects one explicit user action. A
  // header click or a pointer-down inside the body flips this ref, and
  // the effect below then leaves the card alone on completion. This is
  // the "mount-time state from props" pattern (CLAUDE.md, Rules learned
  // the hard way): pair the `useState` with a `useEffect` that syncs on
  // the prop, gated on a `userTouched` ref.
  const userTouchedRef = useRef(false);

  useEffect(() => {
    // Errors override every policy and every prior toggle: the body
    // holds the message that names the corrective action, so a card
    // that arrives at `error` opens. It never auto-collapses afterwards
    // (`error` is terminal, so this effect does not run again; a manual
    // collapse of an error card therefore also sticks).
    if (status === "error") {
      setExpanded(true);
      return;
    }

    // `always-expanded` never collapses a card. The user asked for
    // everything open; short of an error the effect leaves them alone.
    if (policy === "always-expanded") return;

    // Auto-collapse when the call completes, unless the user touched
    // the card. `completed` is terminal in the stream store, so this
    // fires once — on the streaming/running→completed edge, or at
    // mount, where it matches `initialExpanded` and is a no-op.
    if (status === "completed" && !userTouchedRef.current) {
      setExpanded(false);
    }
  }, [status, policy]);

  const isError = status === "error";

  // Each card needs its own body id: `toolName` repeats across calls in
  // a thread, and `aria-controls` must reference exactly one element.
  const bodyId = useId();

  const markTouched = () => {
    userTouchedRef.current = true;
  };

  const handleToggle = () => {
    markTouched();
    setExpanded((v) => !v);
  };

  return (
    <section
      className={cn(
        "group/tool relative flex overflow-hidden rounded-md border bg-[--bg]",
        isError
          ? "border-danger-500/40"
          : "border-[--border]",
      )}
    >
      {/* Category strip — 2px on the left edge, color-coded by tool family. */}
      <div
        aria-hidden
        className={cn("w-[2px] shrink-0", CATEGORY_STRIP[category])}
      />

      <div className="flex-1 min-w-0">
        {/* Header: clickable to toggle expansion. The scanner-line overlay
            only animates while running, in the category color. */}
        <button
          type="button"
          onClick={handleToggle}
          className={cn(
            "relative w-full flex items-center gap-2 px-2.5 py-1.5",
            "text-left text-xs font-mono leading-none",
            "hover:bg-ink-wash",
            "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-500/40",
            "transition-colors",
          )}
          aria-expanded={expanded}
          // The body unmounts while collapsed, so only reference it when
          // it exists — a dangling aria-controls id is invalid.
          aria-controls={expanded ? bodyId : undefined}
        >
          <ChevronRight
            className={cn(
              "h-3 w-3 shrink-0 text-muted transition-transform",
              expanded && "rotate-90",
            )}
            aria-hidden
          />
          <Icon
            className={cn("h-3.5 w-3.5 shrink-0", CATEGORY_TEXT[category])}
            aria-hidden
          />
          <span
            title={toolName}
            className={cn(
              "shrink-0 uppercase tracking-[0.08em] text-[10px] font-semibold",
              CATEGORY_TEXT[category],
            )}
          >
            {prettyToolName(toolName)}
          </span>
          {target && (
            <span className="truncate text-[--fg]/85 min-w-0 flex-1">
              {target}
            </span>
          )}
          {!target && <span className="flex-1" />}
          {summary && (
            <span className="shrink-0 text-muted text-[11px]">
              {summary}
            </span>
          )}
          <StatusPip status={status} />

          {/* Scanner overlay — only active while running. The gradient sweeps
              left→right behind the header content, low-alpha, in the
              category color via currentColor. */}
          {isActiveStatus(status) && (
            <span
              aria-hidden
              className={cn(
                "absolute inset-0 pointer-events-none overflow-hidden",
                CATEGORY_TEXT[category],
              )}
            >
              <span
                className="tool-scan-sweep absolute inset-y-0 -left-1/3 w-1/3 opacity-[0.18]"
                style={{
                  background:
                    "linear-gradient(90deg, transparent, currentColor, transparent)",
                  animation: "tool-scan 1.6s ease-in-out infinite",
                }}
              />
            </span>
          )}
        </button>

        {/* Body. A pointer-down here counts as a user touch: someone
            expanding truncated output or selecting text mid-run must not
            lose it to the auto-collapse when the call completes. */}
        {expanded && (
          <div
            id={bodyId}
            onPointerDown={markTouched}
            className={cn(
              "border-t border-[--border]",
              isError && "border-t-danger-500/30",
            )}
          >
            {children}
          </div>
        )}
      </div>

      {/* Scanner keyframes — scoped to a global keyframes name; defining
          here as a style tag is the pragmatic approach since the project
          doesn't have a CSS layer for animations beyond the Tailwind
          extension. */}
      <style>{`
        @keyframes tool-scan {
          0%   { transform: translateX(0%); }
          50%  { transform: translateX(380%); }
          100% { transform: translateX(0%); }
        }
        @media (prefers-reduced-motion: reduce) {
          .tool-scan-sweep { animation: none !important; opacity: 0.12 !important; }
        }
      `}</style>
    </section>
  );
}

function StatusPip({ status }: { status: ToolStatus }) {
  return (
    <span
      className={cn(
        "shrink-0 inline-flex items-center gap-1 text-[10px] uppercase tracking-wider font-medium",
        isActiveStatus(status) && "text-muted",
        status === "completed" && "text-success-600 dark:text-success-500",
        status === "error" && "text-danger-600 dark:text-danger-500",
      )}
    >
      <span
        aria-hidden
        className={cn(
          "h-1.5 w-1.5 rounded-full",
          STATUS_DOT[status],
          isActiveStatus(status) && "animate-pulse motion-reduce:animate-none",
        )}
      />
      {statusLabel(status)}
    </span>
  );
}

/**
 * Copy-to-clipboard affordance for tool bodies. `getText` is lazy so
 * renderers can assemble command+output at click time. Flashes a check for
 * a moment after a successful copy.
 */
export function CopyButton({
  getText,
  label = "Copy",
  className,
}: {
  getText: () => string;
  label?: string;
  className?: string;
}) {
  const { copied, copy } = useCopyToClipboard();

  const Icon = copied ? Check : Copy;
  return (
    <button
      type="button"
      onClick={() => void copy(getText())}
      aria-label={label}
      title={label}
      className={cn(
        "rounded p-1 text-muted/70 hover:text-[--fg] hover:bg-ink-wash",
        "opacity-0 group-hover/tool:opacity-100 focus-visible:opacity-100 transition-opacity",
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-500/40",
        copied && "text-success-600 dark:text-success-500 opacity-100",
        className,
      )}
    >
      <Icon className="h-3.5 w-3.5" aria-hidden />
    </button>
  );
}

/**
 * Thin code-block-like body container. Most tool renderers use this as
 * their root body element. Pads, monospaces, and applies a subtle inset
 * tint that distinguishes the body from the header.
 */
export function ToolBody({
  children,
  className,
}: {
  children: ReactNode;
  className?: string;
}) {
  return (
    <div
      className={cn(
        "px-2.5 py-2 bg-neutral-50/50 dark:bg-neutral-950/40",
        "text-[12px] leading-snug",
        className,
      )}
    >
      {children}
    </div>
  );
}

/**
 * Truncated text block: shows the first `maxLines` lines of `text` and a
 * "show all" affordance for the rest. Used for raw outputs / file contents
 * that may be arbitrarily long.
 */
export function TruncatedText({
  text,
  maxLines = 12,
  numbered = false,
  className,
}: {
  text: string;
  maxLines?: number;
  numbered?: boolean;
  className?: string;
}) {
  const [showAll, setShowAll] = useState(false);
  const lines = text.split("\n");
  const truncated = !showAll && lines.length > maxLines;
  const visible = truncated ? lines.slice(0, maxLines) : lines;
  const hidden = lines.length - visible.length;

  return (
    <div className={cn("font-mono text-[12px] leading-[1.55]", className)}>
      <pre className="whitespace-pre overflow-x-auto">
        {visible.map((line, i) => (
          <div key={i} className="flex">
            {numbered && (
              <span
                aria-hidden
                className="select-none w-9 pr-3 text-right text-muted/60 shrink-0"
              >
                {i + 1}
              </span>
            )}
            <span className="text-[--fg]/90 min-w-0">{line || " "}</span>
          </div>
        ))}
      </pre>
      {truncated && (
        <button
          type="button"
          onClick={() => setShowAll(true)}
          className="mt-1.5 text-[11px] text-muted hover:text-[--fg] underline-offset-2 hover:underline"
        >
          + {hidden} more {hidden === 1 ? "line" : "lines"}
        </button>
      )}
    </div>
  );
}

/**
 * Format a path with the directory prefix muted and the filename emphasised.
 * Ubiquitous in the read/write/edit renderers.
 */
export function PathLabel({ path, className }: { path: string; className?: string }) {
  const lastSlash = path.lastIndexOf("/");
  const dir = lastSlash >= 0 ? path.slice(0, lastSlash + 1) : "";
  const name = lastSlash >= 0 ? path.slice(lastSlash + 1) : path;
  return (
    <span className={cn("font-mono", className)}>
      {dir && <span className="text-muted/80">{dir}</span>}
      <span className="text-[--fg]/95">{name}</span>
    </span>
  );
}
