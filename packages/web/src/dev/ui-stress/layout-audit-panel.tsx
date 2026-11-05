import { useEffect, useState } from "react";
import { auditLayout, type LayoutFinding } from "./layout-audit";

/** Runs the layout audit after the page settles and again after each
 * resize, and lists what overflows at the current width. */
export function LayoutAuditPanel() {
  const [result, setResult] = useState<{ width: number; findings: LayoutFinding[] } | null>(null);

  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const run = () => {
      clearTimeout(timer);
      // Fixtures, fonts, and the open bell render over several frames.
      timer = setTimeout(() => setResult({ width: document.documentElement.clientWidth, findings: auditLayout(document.body) }), 1500);
    };
    run();
    window.addEventListener("resize", run);
    return () => { clearTimeout(timer); window.removeEventListener("resize", run); };
  }, []);

  if (!result) return <p role="status" className="text-sm text-muted">Layout audit runs once the page settles…</p>;
  return (
    <div data-layout-audit-skip role="status" className="rounded-lg border border-line p-3 text-sm">
      {result.findings.length === 0 ? (
        <p className="text-ink">Layout audit: nothing overflows at {result.width}px.</p>
      ) : (
        <>
          <p className="font-medium text-danger-600">Layout audit: {result.findings.length} overflow at {result.width}px.</p>
          <ul className="mt-2 space-y-1 font-mono text-xs text-muted">
            {result.findings.map((finding, index) => (
              <li key={index} className="[overflow-wrap:anywhere]">+{finding.overflow}px {finding.element} “{finding.text}”</li>
            ))}
          </ul>
        </>
      )}
    </div>
  );
}
