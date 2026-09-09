import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { ChevronRight, Minus, Move, Plus, RotateCcw } from "lucide-react";
import { CodeBlock } from "./code-block";
import { renderMermaid } from "~/lib/mermaid";
import { useMermaidTheme } from "~/lib/use-mermaid-theme";
import { cn } from "~/lib/cn";

interface RenderState {
  source: string;
  svg?: string;
  failed?: boolean;
}

interface Viewport {
  scale: number;
  x: number;
  y: number;
}

interface DragStart {
  pointerId: number;
  x: number;
  y: number;
}

const DEFAULT_VIEWPORT: Viewport = { scale: 1, x: 0, y: 0 };
const MIN_SCALE = 0.5;
const MAX_SCALE = 3;
const SCALE_STEP = 0.2;

/** Clamp Mermaid zoom to the range the diagram viewport supports. */
export function clampMermaidScale(scale: number): number {
  return Math.min(MAX_SCALE, Math.max(MIN_SCALE, scale));
}

/** A fenced Mermaid block rendered from untrusted source. */
export function MermaidDiagram({ source }: { source: string }) {
  const reactId = useId();
  const theme = useMermaidTheme();
  const [state, setState] = useState<RenderState>({ source });
  const [collapsed, setCollapsed] = useState(false);
  const [viewport, setViewport] = useState<Viewport>(DEFAULT_VIEWPORT);
  const dragStartRef = useRef<DragStart | undefined>(undefined);

  useEffect(() => {
    let active = true;
    const id = `mermaid-${reactId.replace(/[^A-Za-z0-9_-]/g, "")}`;
    setState({ source });
    void renderMermaid(source, id, theme).then(
      (svg) => {
        if (active) setState({ source, svg });
      },
      () => {
        if (active) setState({ source, failed: true });
      },
    );
    return () => {
      active = false;
    };
  }, [reactId, source, theme]);

  // A new diagram must not inherit a prior diagram's pan or zoom position.
  useEffect(() => {
    setViewport(DEFAULT_VIEWPORT);
  }, [source]);

  const changeScale = (change: number) => {
    setViewport((current) => ({ ...current, scale: clampMermaidScale(current.scale + change) }));
  };

  const resetViewport = () => setViewport(DEFAULT_VIEWPORT);

  if (state.source === source && state.svg) {
    return (
      <section className="mermaid-diagram my-3 overflow-hidden rounded-md border border-[--border] bg-[--bg]">
        <header className="flex items-center gap-2 border-b border-[--border] px-2.5 py-1.5">
          <button
            type="button"
            onClick={() => setCollapsed((value) => !value)}
            className="flex min-w-0 flex-1 items-center gap-2 text-left text-xs font-mono hover:text-accent-600 dark:hover:text-accent-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-500/40"
            aria-expanded={!collapsed}
            aria-controls={`mermaid-body-${reactId}`}
          >
            <ChevronRight
              className={cn("h-3 w-3 shrink-0 text-muted transition-transform", !collapsed && "rotate-90")}
              aria-hidden
            />
            <Move className="h-3.5 w-3.5 shrink-0 text-sky-700 dark:text-sky-400" aria-hidden />
            <span className="truncate uppercase tracking-[0.08em] text-[10px] font-semibold text-sky-700 dark:text-sky-400">
              Mermaid diagram
            </span>
          </button>
          {!collapsed && (
            <div className="flex shrink-0 items-center gap-0.5" aria-label="Diagram controls">
              <DiagramButton label="Zoom out" onClick={() => changeScale(-SCALE_STEP)}>
                <Minus className="h-3.5 w-3.5" aria-hidden />
              </DiagramButton>
              <DiagramButton label="Zoom in" onClick={() => changeScale(SCALE_STEP)}>
                <Plus className="h-3.5 w-3.5" aria-hidden />
              </DiagramButton>
              <DiagramButton label="Reset diagram view" onClick={resetViewport}>
                <RotateCcw className="h-3.5 w-3.5" aria-hidden />
              </DiagramButton>
            </div>
          )}
        </header>
        {!collapsed && (
          <div
            id={`mermaid-body-${reactId}`}
            data-max-height="384"
            className="max-h-96 overflow-hidden bg-ink-wash"
            onPointerDown={(event) => {
              dragStartRef.current = { pointerId: event.pointerId, x: event.clientX, y: event.clientY };
              event.currentTarget.setPointerCapture?.(event.pointerId);
            }}
            onPointerMove={(event) => {
              const dragStart = dragStartRef.current;
              if (!dragStart || dragStart.pointerId !== event.pointerId) return;
              setViewport((current) => ({
                ...current,
                x: current.x + event.clientX - dragStart.x,
                y: current.y + event.clientY - dragStart.y,
              }));
              dragStartRef.current = { ...dragStart, x: event.clientX, y: event.clientY };
            }}
            onPointerUp={(event) => {
              if (dragStartRef.current?.pointerId === event.pointerId) dragStartRef.current = undefined;
            }}
            onPointerCancel={() => {
              dragStartRef.current = undefined;
            }}
            onWheel={(event) => {
              event.preventDefault();
              changeScale(event.deltaY < 0 ? SCALE_STEP : -SCALE_STEP);
            }}
          >
            <img
              src={`data:image/svg+xml;charset=utf-8,${encodeURIComponent(state.svg)}`}
              alt="Mermaid diagram"
              className="mx-auto block max-w-full cursor-grab select-none active:cursor-grabbing"
              draggable={false}
              style={{ transform: `translate(${viewport.x}px, ${viewport.y}px) scale(${viewport.scale})` }}
            />
          </div>
        )}
      </section>
    );
  }

  return (
    <div className="mermaid-diagram my-3" data-state={state.failed ? "error" : "loading"}>
      {state.failed && (
        <p role="alert" className="mb-2 text-sm text-danger-600 dark:text-danger-400">
          Diagram could not render. Check the Mermaid syntax. The source is shown below.
        </p>
      )}
      <CodeBlock code={source} language="mermaid" />
    </div>
  );
}

function DiagramButton({ children, label, onClick }: { children: ReactNode; label: string; onClick: () => void }) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      onClick={onClick}
      className="rounded p-1 text-muted hover:bg-ink-wash hover:text-[--fg] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-500/40"
    >
      {children}
    </button>
  );
}
