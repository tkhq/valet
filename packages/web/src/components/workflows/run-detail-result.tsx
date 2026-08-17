/**
 * The answer a settled run produced, at the top of `/workflows/runs/$runId`.
 *
 * A stop node's `message` and `output` are the reason the person started the
 * run. They used to sit inside a collapsed "Result" toggle on one checkpoint
 * row, below the canvas and every other node, identified only by node id.
 * This panel promotes them: the message reads as prose, the output reads as
 * structured data, and a failure reason gets the same position a success
 * message gets.
 */
import { CodeBlock } from "~/components/code-block";
import { RUN_STATUS_GLYPH } from "./editor/flow-node";
import { formatRunOutput, type RunResult, type RunResultDiagnostic } from "./run-detail-helpers";

/** Headline per outcome. The chip in the header already carries the outcome
 * word, so the panel names its contents instead of repeating it. */
const HEADING: Record<RunResult["outcome"], string> = {
  completed: "Result",
  failed: "Failure reason",
  cancelled: "Cancelled",
};

const GLYPH: Record<RunResult["outcome"], string> = {
  completed: RUN_STATUS_GLYPH.succeeded,
  failed: RUN_STATUS_GLYPH.failed,
  cancelled: RUN_STATUS_GLYPH.skipped,
};

const ACCENT: Record<RunResult["outcome"], string> = {
  completed: "text-success-600 dark:text-success-500",
  failed: "text-danger-500",
  cancelled: "text-muted",
};

const BORDER: Record<RunResult["outcome"], string> = {
  completed: "border-success-500/40",
  failed: "border-danger-500/50",
  cancelled: "border-line",
};

/**
 * What to say when the run settled but recorded nothing to read. Each line
 * names the action that produces a result next time, because an empty panel
 * otherwise looks like a loading failure.
 */
const EMPTY_BODY: Record<RunResult["outcome"], string> = {
  completed:
    "The workflow finished without a result message. To summarize a run here, set a message on its stop node.",
  failed:
    "No node recorded a reason. Read the checkpoints below to find the node that stopped the run.",
  cancelled: "The run stopped where it was. To run the workflow again, select Retry run.",
};

export interface RunResultPanelProps {
  result: RunResult;
}

export function RunResultPanel({ result }: RunResultPanelProps) {
  const output = formatRunOutput(result.output);
  const hasBody = result.message !== undefined || output !== undefined;

  return (
    <section
      aria-label="Run result"
      className={`rounded-lg border bg-paper p-4 ${BORDER[result.outcome]}`}
    >
      <div className="flex items-baseline gap-2">
        <span className={`text-sm ${ACCENT[result.outcome]}`} aria-hidden>
          {GLYPH[result.outcome]}
        </span>
        <h2 className="flex-1 text-sm font-semibold tracking-tight text-ink">
          {HEADING[result.outcome]}
        </h2>
        {result.nodeId && (
          <span className="shrink-0 truncate font-mono text-xs text-muted">{result.nodeId}</span>
        )}
      </div>

      {result.message !== undefined && (
        // The message is authored prose with rendered template values in it.
        // Line breaks are the author's, so they are kept.
        <p
          className={`mt-3 whitespace-pre-wrap text-sm leading-relaxed ${
            result.outcome === "failed" ? "text-danger-500" : "text-ink"
          }`}
        >
          {result.message}
        </p>
      )}

      {output && (
        <div className="mt-3">
          <h3 className="text-xs font-medium uppercase tracking-wide text-muted">Output</h3>
          {output.kind === "json" ? (
            // A large output must not push the steps off the screen, so the
            // block scrolls inside its own box.
            <div className="mt-1 max-h-96 overflow-auto">
              <CodeBlock code={output.text} language="json" />
            </div>
          ) : (
            <p className="mt-1 whitespace-pre-wrap text-sm leading-relaxed text-ink">
              {output.text}
            </p>
          )}
        </div>
      )}

      {!hasBody && <p className="mt-3 text-sm text-muted">{EMPTY_BODY[result.outcome]}</p>}

      {result.diagnostics.length > 0 && <DiagnosticsBlock diagnostics={result.diagnostics} />}
    </section>
  );
}

/**
 * Unresolved template paths. A path that misses renders as empty rather than
 * failing the run, so a run can report success and still carry a blank where
 * a value belongs. Listing the paths is what makes that visible.
 */
function DiagnosticsBlock({ diagnostics }: { diagnostics: RunResultDiagnostic[] }) {
  return (
    <div className="mt-4 rounded border border-amber-500/40 bg-amber-500/5 p-3">
      <h3 className="text-xs font-semibold text-amber-700 dark:text-amber-300">
        {diagnostics.length === 1
          ? "1 template path did not resolve"
          : `${diagnostics.length} template paths did not resolve`}
      </h3>
      <ul className="mt-2 space-y-2">
        {diagnostics.map((d) => (
          <li key={`${d.nodeId ?? ""}:${d.field ?? ""}:${d.path}`} className="text-xs text-muted">
            <div>
              <code className="font-mono text-ink">{d.path}</code>
              {d.nodeId && (
                <span>
                  {" in "}
                  {d.nodeId}
                  {d.field && `.${d.field}`}
                </span>
              )}
            </div>
            {d.detail && <div className="mt-0.5">{d.detail}</div>}
            {/* The producer resolves every suggestion against the run's own
                data before it offers one, so this path is known to work. */}
            {d.suggestion && (
              <div className="mt-0.5">
                Write <code className="font-mono text-ink">{d.suggestion}</code> instead.
              </div>
            )}
          </li>
        ))}
      </ul>
      <p className="mt-2 text-xs text-muted">
        Each path above produced an empty value. Correct the paths in the workflow, then start a
        new run.
      </p>
    </div>
  );
}
