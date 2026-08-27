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

// Narrow shapes we can render as structured turns.
interface TextBlock {
  type: "text";
  text: string;
}

interface ToolUseBlock {
  type: "tool_use";
  name: string;
  input: unknown;
}

interface ToolResultBlock {
  type: "tool_result";
  tool_use_id: string;
  content: unknown;
}

type ContentBlock = TextBlock | ToolUseBlock | ToolResultBlock | { type: string; [k: string]: unknown };

interface Turn {
  role: string;
  content: string | ContentBlock[];
}

interface ParsedSample {
  system?: string | ContentBlock[];
  tools?: { name: string; description?: string }[];
  messages?: Turn[];
  model?: string;
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function isString(v: unknown): v is string {
  return typeof v === "string";
}

function isArray(v: unknown): v is unknown[] {
  return Array.isArray(v);
}

function contentText(content: unknown): string {
  if (isString(content)) return content;
  if (isArray(content)) {
    return content
      .map((b) => {
        if (isObject(b) && b.type === "text" && isString(b.text)) return b.text;
        if (isObject(b) && b.type === "tool_use") return `[tool: ${isString(b.name) ? b.name : "unknown"}]`;
        if (isObject(b) && b.type === "tool_result") return `[tool_result]`;
        return "";
      })
      .filter(Boolean)
      .join("\n");
  }
  return JSON.stringify(content, null, 2);
}

function SystemBlock({ system }: { system: string | ContentBlock[] }) {
  const text = isString(system) ? system : contentText(system);
  return (
    <div className="mb-4">
      <div className="text-xs font-semibold uppercase tracking-wide text-muted mb-1">System</div>
      <pre className="whitespace-pre-wrap text-xs text-ink bg-paper-muted rounded p-3 border border-line overflow-auto max-h-48">
        {text}
      </pre>
    </div>
  );
}

function ToolsBlock({ tools }: { tools: { name: string; description?: string }[] }) {
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

function TurnBlock({ turn }: { turn: Turn }) {
  const isAssistant = turn.role === "assistant";
  const text = contentText(turn.content);
  return (
    <div className={`mb-3 ${isAssistant ? "pl-4 border-l-2 border-moss" : ""}`}>
      <div className="text-xs font-semibold uppercase tracking-wide text-muted mb-1">
        {turn.role}
      </div>
      <pre className="whitespace-pre-wrap text-xs text-ink leading-relaxed overflow-auto max-h-64">
        {text}
      </pre>
    </div>
  );
}

function StructuredView({ parsed }: { parsed: ParsedSample }) {
  return (
    <div>
      {parsed.model && (
        <div className="mb-3 text-xs text-muted">
          Model: <span className="text-ink">{parsed.model}</span>
        </div>
      )}
      {parsed.system && <SystemBlock system={parsed.system} />}
      {parsed.tools && parsed.tools.length > 0 && <ToolsBlock tools={parsed.tools} />}
      {parsed.messages && parsed.messages.length > 0 && (
        <div>
          <div className="text-xs font-semibold uppercase tracking-wide text-muted mb-2">
            Messages ({parsed.messages.length})
          </div>
          {parsed.messages.map((turn, i) => (
            <TurnBlock key={i} turn={turn} />
          ))}
        </div>
      )}
    </div>
  );
}

function isParsedSample(v: unknown): v is ParsedSample {
  return isObject(v);
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
