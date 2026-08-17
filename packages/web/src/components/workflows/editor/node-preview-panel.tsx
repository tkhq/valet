/**
 * Node preview panel — what each step would receive, before the workflow
 * runs.
 *
 * The panel renders a `PreviewWorkflowResponse` from
 * `POST /api/workflows/:id/preview`. Its job is to keep the server's honesty
 * visible: a step that really ran and a step that was only described must
 * never look alike on screen. So a described step shows a shape and the
 * reason it was not run, never a value; only an executed step shows an
 * output. The unresolved paths come first on every card, because a path
 * that resolves to nothing is the one thing a run page cannot tell anybody
 * until the work is already paid for.
 *
 * Presentational by design: it holds the sample input a person types and
 * nothing else. The editor that mounts it owns the request.
 */
import { useState } from "react";
import type {
  PreviewNode,
  PreviewUnresolvedPath,
  PreviewWorkflowResponse,
} from "@valet/api/wire";
import { Badge, Button, Textarea } from "~/components/primitives";
import { cn } from "~/lib/cn";

export type NodePreviewStatus = "idle" | "loading" | "ready" | "error";

export interface NodePreviewRequest {
  /** Sample trigger fields, parsed from what the person typed. */
  input: Record<string, unknown>;
  /** The selected node, when the editor has one. */
  nodeId?: string;
}

export interface NodePreviewPanelProps {
  /** The node the editor has selected. Omit to preview the whole workflow. */
  nodeId?: string;
  preview?: PreviewWorkflowResponse;
  status: NodePreviewStatus;
  /** What went wrong, when `status` is `error`. */
  errorText?: string;
  onPreview: (request: NodePreviewRequest) => void;
}

/**
 * The sample input box holds JSON, so a person can type any trigger shape.
 * A parse failure returns the reason instead of an object — the panel
 * refuses to send rather than quietly previewing against no input at all.
 */
export function parseSampleInput(text: string): { input: Record<string, unknown> } | { error: string } {
  const trimmed = text.trim();
  if (trimmed === "") return { input: {} };
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    return { error: `Sample input is not valid JSON (${detail}). Fix the JSON, or clear the box.` };
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return { error: 'Sample input must be a JSON object, e.g. {"email": "a@example.com"}.' };
  }
  return { input: parsed as Record<string, unknown> };
}

export function NodePreviewPanel({
  nodeId,
  preview,
  status,
  errorText,
  onPreview,
}: NodePreviewPanelProps) {
  const [sampleText, setSampleText] = useState("");
  const [inputError, setInputError] = useState<string | undefined>(undefined);

  const run = () => {
    const parsed = parseSampleInput(sampleText);
    if ("error" in parsed) {
      setInputError(parsed.error);
      return;
    }
    setInputError(undefined);
    onPreview({ input: parsed.input, ...(nodeId !== undefined ? { nodeId } : {}) });
  };

  return (
    <div className="flex h-full flex-col" data-testid="node-preview-panel">
      <div className="border-b border-line px-3 py-2">
        <label className="block text-[10px] font-medium uppercase tracking-wide text-muted" htmlFor="preview-sample">
          Sample trigger input
        </label>
        <Textarea
          id="preview-sample"
          value={sampleText}
          onChange={(e) => setSampleText(e.target.value)}
          rows={3}
          spellCheck={false}
          placeholder={'{"email": "a@example.com"}'}
          className="mt-1 font-mono text-xs"
        />
        {inputError !== undefined && (
          <p role="alert" className="mt-1 text-xs text-danger-600 dark:text-danger-500">
            {inputError}
          </p>
        )}
        <div className="mt-2 flex items-center gap-2">
          <Button size="sm" onClick={run} disabled={status === "loading"}>
            {status === "loading" ? "Previewing…" : "Preview"}
          </Button>
          <span className="text-xs text-muted">
            {nodeId === undefined ? "Every step" : `Step "${nodeId}"`}
          </span>
        </div>
      </div>

      {status === "error" && (
        <p role="alert" className="border-b border-line px-3 py-2 text-xs text-danger-600 dark:text-danger-500">
          {errorText ?? "The preview did not run. Try again."}
        </p>
      )}

      <div className="flex-1 overflow-y-auto">
        {preview === undefined ? (
          <p className="px-3 py-4 text-xs text-muted">
            Preview resolves every {"{{ ... }}"} path against your last run, so you can see what each step
            would receive before you spend a run on it.
          </p>
        ) : (
          <>
            <SampleSummary preview={preview} />
            {preview.nodes.map((node) => (
              <NodeCard key={node.nodeId} node={node} />
            ))}
          </>
        )}
      </div>
    </div>
  );
}

/** Where the values came from. Read this before anything below it. */
function SampleSummary({ preview }: { preview: PreviewWorkflowResponse }) {
  const { sample } = preview;
  return (
    <div className="border-b border-line px-3 py-2 text-xs" data-testid="preview-sample-summary">
      <p className="text-muted">
        {sample.kind === "last_run"
          ? `Values from run ${sample.runId}${sample.runCreatedAt ? ` (${new Date(sample.runCreatedAt).toLocaleString()})` : ""}.`
          : "No run to read from yet. Values come from the sample input and from the steps this preview could run."}
      </p>
      {sample.fromPreview.length > 0 && (
        <p className="mt-1 text-muted">
          Computed by this preview: {sample.fromPreview.join(", ")}.
        </p>
      )}
      {sample.inputErrors.length > 0 && (
        <ul className="mt-1 space-y-0.5 text-danger-600 dark:text-danger-500">
          {sample.inputErrors.map((error) => (
            <li key={error.field}>{error.message}</li>
          ))}
        </ul>
      )}
    </div>
  );
}

function NodeCard({ node }: { node: PreviewNode }) {
  const ran = node.fidelity === "executed";
  return (
    <section className="border-b border-line px-3 py-2" data-testid={`preview-node-${node.nodeId}`}>
      <header className="flex items-center gap-2">
        <span className="font-mono text-xs">{node.nodeId}</span>
        <span className="text-[10px] uppercase tracking-wide text-muted">{node.type}</span>
        {/* The single most load-bearing element on the card: it separates a
            measured value from a predicted one. */}
        <Badge variant={ran ? "success" : "neutral"}>{ran ? "Ran" : "Not run"}</Badge>
      </header>

      {node.error !== undefined && (
        <p role="alert" className="mt-1 text-xs text-danger-600 dark:text-danger-500">
          {node.error}
        </p>
      )}

      {node.unresolved.length > 0 && <UnresolvedList paths={node.unresolved} />}

      {node.fields.length > 0 && (
        <dl className="mt-2 space-y-1" data-testid={`preview-fields-${node.nodeId}`}>
          {node.fields.map((field) => (
            <div key={field.field} className="text-xs">
              <dt className="font-mono text-muted">{field.field}</dt>
              <dd
                className={cn(
                  "whitespace-pre-wrap break-words font-mono",
                  field.unresolvedPaths.length > 0 && "text-danger-600 dark:text-danger-500",
                )}
              >
                {formatValue(field.resolved)}
              </dd>
            </div>
          ))}
        </dl>
      )}

      {ran ? (
        <div className="mt-2 text-xs" data-testid={`preview-output-${node.nodeId}`}>
          <p className="text-[10px] font-medium uppercase tracking-wide text-muted">Output</p>
          <pre className="mt-1 overflow-x-auto whitespace-pre-wrap break-words font-mono">
            {formatValue(node.output)}
          </pre>
        </div>
      ) : (
        <DescribedShape node={node} />
      )}

      {node.warnings.length > 0 && (
        <ul className="mt-2 space-y-0.5 text-xs text-warning-fg" data-testid={`preview-warnings-${node.nodeId}`}>
          {node.warnings.map((warning) => (
            <li key={warning}>{warning}</li>
          ))}
        </ul>
      )}
    </section>
  );
}

function UnresolvedList({ paths }: { paths: PreviewUnresolvedPath[] }) {
  return (
    <ul className="mt-2 space-y-1 text-xs text-danger-600 dark:text-danger-500" data-testid="preview-unresolved">
      {paths.map((miss) => (
        <li key={`${miss.field}|${miss.path}`}>
          <span className="font-mono">{miss.path}</span> — {miss.message}
        </li>
      ))}
    </ul>
  );
}

/**
 * A step that was not run. The reason comes first, so nobody reads the
 * paths below it as values that exist right now.
 */
function DescribedShape({ node }: { node: PreviewNode }) {
  return (
    <div className="mt-2 text-xs" data-testid={`preview-shape-${node.nodeId}`}>
      <p className="text-muted">{node.describedReason}</p>
      {node.outputShape.note !== undefined && <p className="mt-1 text-muted">{node.outputShape.note}</p>}
      {node.outputShape.paths.length > 0 && (
        <>
          <p className="mt-1 text-[10px] font-medium uppercase tracking-wide text-muted">
            {node.outputShape.origin === "observed"
              ? "Paths from its last real result"
              : "Paths it would produce"}
          </p>
          <ul className="mt-0.5 space-y-0.5 font-mono">
            {node.outputShape.paths.map((path) => (
              <li key={path}>{path}</li>
            ))}
          </ul>
        </>
      )}
    </div>
  );
}

/** Values are shown as JSON so `null`, `""` and `0` stay distinguishable —
 * the three things an unresolved path collapses into. */
function formatValue(value: unknown): string {
  if (value === undefined) return "(no value)";
  if (typeof value === "string") return value === "" ? '""' : value;
  return JSON.stringify(value, null, 2) ?? "(no value)";
}
