/**
 * Drill-down view for a single proxy request. Fetches the full detail row
 * from `GET /api/proxy/requests/:id`, renders the `parsed` field as readable
 * blocks (system prompt, tools, input turns, assistant output), and provides
 * a "View raw" toggle showing the verbatim request/response bodies.
 *
 * Falls back to raw JSON when `parsed` is null.
 */
import { useState } from "react";
import { useProxyRequestDetail } from "~/api/proxy-usage";

interface SampleViewProps {
  id: string;
  onClose: () => void;
}

// Mirrors the ContentBlock union from packages/api/src/proxy/sample.ts.
// Kept local so the web package does not import from the api package directly.
type ContentBlock =
  | { type: "text"; text: string }
  | { type: "image"; source: Record<string, unknown> }
  | { type: "tool_use"; id: string; name: string; input: Record<string, unknown> }
  | { type: "tool_result"; tool_use_id: string; content: unknown }
  | { type: "reasoning"; thinking: string }
  | { type: "unknown"; raw: unknown }
  | { type: string; [k: string]: unknown };

interface SampleMessage {
  role: string;
  content: ContentBlock[];
}

interface SampleTool {
  name: string;
  description?: string;
}

// Real shape produced by parseSample in packages/api/src/proxy/sample.ts.
interface ParsedSample {
  schema?: string;
  model?: string;
  system?: string | null;
  tools?: SampleTool[];
  input?: SampleMessage[];
  output?: SampleMessage;
  [k: string]: unknown;
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function isString(v: unknown): v is string {
  return typeof v === "string";
}

function isParsedSample(v: unknown): v is ParsedSample {
  return isObject(v);
}

/** Render a single ContentBlock as readable text. */
function renderBlock(block: ContentBlock, i: number): React.ReactNode {
  if (block.type === "text") {
    return (
      <pre key={i} className="whitespace-pre-wrap text-xs text-ink leading-relaxed overflow-auto max-h-64">
        {block.text}
      </pre>
    );
  }
  if (block.type === "tool_use") {
    return (
      <div key={i} className="mb-1">
        <span className="text-xs font-mono text-muted">tool_use: </span>
        <span className="text-xs font-mono text-ink">{block.name}</span>
        <pre className="whitespace-pre-wrap text-xs text-ink bg-paper-muted rounded p-2 border border-line overflow-auto max-h-32 mt-1">
          {JSON.stringify(block.input, null, 2)}
        </pre>
      </div>
    );
  }
  if (block.type === "tool_result") {
    const contentStr = isString(block.content)
      ? block.content
      : JSON.stringify(block.content, null, 2);
    return (
      <div key={i} className="mb-1">
        <span className="text-xs font-mono text-muted">tool_result</span>
        <pre className="whitespace-pre-wrap text-xs text-ink bg-paper-muted rounded p-2 border border-line overflow-auto max-h-32 mt-1">
          {contentStr}
        </pre>
      </div>
    );
  }
  if (block.type === "image") {
    return (
      <div key={i} className="text-xs text-muted italic">[image attachment]</div>
    );
  }
  if (block.type === "reasoning") {
    return (
      <pre key={i} className="whitespace-pre-wrap text-xs text-muted italic leading-relaxed overflow-auto max-h-32">
        {(block as { type: "reasoning"; thinking: string }).thinking}
      </pre>
    );
  }
  // unknown — show raw JSON
  return (
    <pre key={i} className="whitespace-pre-wrap text-xs text-ink bg-paper-muted rounded p-2 border border-line overflow-auto max-h-32 mt-1">
      {JSON.stringify((block as { type: string; raw?: unknown }).raw ?? block, null, 2)}
    </pre>
  );
}

function SystemBlock({ system }: { system: string }) {
  return (
    <div className="mb-4">
      <div className="text-xs font-semibold uppercase tracking-wide text-muted mb-1">System</div>
      <pre className="whitespace-pre-wrap text-xs text-ink bg-paper-muted rounded p-3 border border-line overflow-auto max-h-48">
        {system}
      </pre>
    </div>
  );
}

function ToolsBlock({ tools }: { tools: SampleTool[] }) {
  return (
    <div className="mb-4">
      <div className="text-xs font-semibold uppercase tracking-wide text-muted mb-1">
        Tools ({tools.length})
      </div>
      <div className="flex flex-wrap gap-2">
        {tools.map((t) => (
          <span
            key={t.name}
            title={t.description}
            className="inline-block rounded px-2 py-0.5 text-xs bg-paper-muted border border-line text-muted"
          >
            {t.name}
          </span>
        ))}
      </div>
    </div>
  );
}

function MessageBlock({ msg }: { msg: SampleMessage }) {
  const isAssistant = msg.role === "assistant";
  return (
    <div className={`mb-3 ${isAssistant ? "pl-4 border-l-2 border-moss" : ""}`}>
      <div className="text-xs font-semibold uppercase tracking-wide text-muted mb-1">
        {msg.role}
      </div>
      {msg.content.map((block, i) => renderBlock(block, i))}
    </div>
  );
}

function StructuredView({ parsed }: { parsed: ParsedSample }) {
  const inputTurns = parsed.input ?? [];
  const output = parsed.output;

  return (
    <div>
      {parsed.model && (
        <div className="mb-3 text-xs text-muted">
          Model: <span className="text-ink">{parsed.model}</span>
        </div>
      )}
      {parsed.system && <SystemBlock system={parsed.system} />}
      {parsed.tools && parsed.tools.length > 0 && <ToolsBlock tools={parsed.tools} />}
      {(inputTurns.length > 0 || output) && (
        <div>
          <div className="text-xs font-semibold uppercase tracking-wide text-muted mb-2">
            Conversation ({inputTurns.length + (output ? 1 : 0)} turns)
          </div>
          {inputTurns.map((msg, i) => (
            <MessageBlock key={i} msg={msg} />
          ))}
          {output && <MessageBlock msg={output} />}
        </div>
      )}
    </div>
  );
}

export function SampleView({ id, onClose }: SampleViewProps) {
  const [showRaw, setShowRaw] = useState(false);
  const { data, isLoading, error } = useProxyRequestDetail(id);

  return (
    <div className="border border-line rounded bg-paper flex flex-col overflow-hidden" style={{ maxHeight: "70vh" }}>
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-2 border-b border-line shrink-0">
        <span className="text-sm font-medium text-ink">Request detail</span>
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => setShowRaw((v) => !v)}
            className="text-xs text-muted hover:text-ink rounded px-2 py-0.5 border border-line hover:border-ink"
          >
            {showRaw ? "View parsed" : "View raw"}
          </button>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close detail"
            className="text-muted hover:text-ink text-sm px-1"
          >
            ✕
          </button>
        </div>
      </div>

      {/* Body */}
      <div className="flex-1 overflow-y-auto px-4 py-3 text-sm">
        {isLoading && <p className="text-muted">Loading…</p>}
        {error && <p className="text-danger-600 text-xs">{String(error)}</p>}
        {data && (
          <>
            {/* Metadata strip */}
            <div className="flex flex-wrap gap-3 text-xs text-muted mb-4">
              <span>Provider: <span className="text-ink">{data.providerKind}</span></span>
              <span>Model: <span className="text-ink">{data.model ?? "—"}</span></span>
              <span>Harness: <span className="text-ink">{data.harness ?? "—"}</span></span>
              <span>Status: <span className="text-ink">{data.statusCode}</span></span>
              <span>Tokens: <span className="text-ink">{data.totalTokens.toLocaleString()}</span></span>
              {data.latencyMs != null && (
                <span>Latency: <span className="text-ink">{data.latencyMs}ms</span></span>
              )}
              {data.costUsd != null && (
                <span>Cost: <span className="text-ink">${data.costUsd.toFixed(4)}</span></span>
              )}
            </div>

            {showRaw || !data.parsed ? (
              <div>
                <div className="text-xs font-semibold uppercase tracking-wide text-muted mb-1">Request body</div>
                <pre className="whitespace-pre-wrap text-xs bg-paper-muted rounded p-3 border border-line overflow-auto max-h-64 mb-4">
                  {data.requestBody}
                </pre>
                {data.responseBody && (
                  <>
                    <div className="text-xs font-semibold uppercase tracking-wide text-muted mb-1">Response body</div>
                    <pre className="whitespace-pre-wrap text-xs bg-paper-muted rounded p-3 border border-line overflow-auto max-h-64">
                      {data.responseBody}
                    </pre>
                  </>
                )}
                {data.parseError && (
                  <p className="mt-2 text-xs text-danger-600">Parse error: {data.parseError}</p>
                )}
              </div>
            ) : isParsedSample(data.parsed) ? (
              <StructuredView parsed={data.parsed} />
            ) : (
              <pre className="whitespace-pre-wrap text-xs bg-paper-muted rounded p-3 border border-line overflow-auto max-h-96">
                {JSON.stringify(data.parsed, null, 2)}
              </pre>
            )}
          </>
        )}
      </div>
    </div>
  );
}
