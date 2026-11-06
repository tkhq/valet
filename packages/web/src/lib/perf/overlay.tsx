import { useMemo, useState, useSyncExternalStore } from "react";
import { createRoot } from "react-dom/client";
import type { Measurement, PerfMonitor } from "./monitor";

/** Rows the overlay shows, newest first. */
const ROWS = 12;

function PerfOverlay({ monitor }: { monitor: PerfMonitor }) {
  const [open, setOpen] = useState(true);
  useSyncExternalStore(useMemo(() => subscribe(monitor), [monitor]), () => monitor.revision());
  const rows = monitor.entries().slice(-ROWS).reverse();
  return <div data-perf-overlay
    className="fixed bottom-2 left-2 z-[100] w-80 rounded-md border border-line bg-paper/95 p-2 font-mono text-[11px] text-ink shadow-lg">
    <div className="flex items-center justify-between gap-2">
      <span className="font-semibold">Latency vs budget</span>
      <span className="flex gap-2">
        <button type="button" className="text-muted hover:text-ink" onClick={() => monitor.clear()}>Clear</button>
        <button type="button" className="text-muted hover:text-ink" onClick={() => setOpen(!open)}>{open ? "Hide" : "Show"}</button>
      </span>
    </div>
    {open && <table className="mt-1 w-full">
      <tbody>
        {rows.length === 0 && <tr><td className="text-muted">Click something to measure it.</td></tr>}
        {rows.map((m, i) => <Row key={`${m.at}-${m.kind}-${i}`} m={m} />)}
      </tbody>
    </table>}
  </div>;
}

function Row({ m }: { m: Measurement }) {
  const over = m.ms > m.budget;
  return <tr className={over ? "text-danger" : undefined}>
    <td className="pr-1 text-muted">{m.kind.slice(0, 4)}</td>
    <td className="max-w-[10rem] truncate pr-1">{m.flow}</td>
    <td className="text-right tabular-nums">{Math.round(m.ms)}</td>
    <td className="pl-1 text-right tabular-nums text-muted">/{m.budget}</td>
  </tr>;
}

function subscribe(monitor: PerfMonitor) {
  return (onChange: () => void) => {
    const offMeasure = monitor.subscribe(onChange);
    const offClear = monitor.onClear(onChange);
    return () => { offMeasure(); offClear(); };
  };
}

/** Mounts the overlay in its own root, outside the app tree, so it never re-renders the app. */
export function mountPerfOverlay(monitor: PerfMonitor): void {
  const host = document.createElement("div");
  document.body.appendChild(host);
  createRoot(host).render(<PerfOverlay monitor={monitor} />);
}
