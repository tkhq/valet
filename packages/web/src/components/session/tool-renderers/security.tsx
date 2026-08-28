import { Link } from "@tanstack/react-router";
import { Boxes, CheckCircle2, FileArchive, Play, ShieldAlert, ShieldHalf } from "lucide-react";
import type { SecurityFindingSeverity } from "@valet/api/wire";
import { SeverityBadge } from "~/components/security/severity";
import { ToolBody, TruncatedText } from "./tool-shell";
import { resultText, type ToolRenderer } from "./types";

/**
 * Renderers for the `sec_*` engagement tools (valet-security design §Data
 * and events): a cell card for `sec_dispatch`, a severity-badged finding
 * card for `sec_finding_report`, status summaries for `sec_cell_complete`
 * and `sec_close`, a gate line for `sec_start`, and a compact one-liner for
 * the rest of the family. Every result read goes through `resultText` —
 * results arrive as `{ text }`, pi-agent-core's content array, or a bare
 * string depending on which persistence era wrote them (the round-trip
 * rule in CLAUDE.md).
 *
 * Finding titles/evidence come from a persona that read HOSTILE code: they
 * render as plain text nodes only, never markdown-with-HTML.
 */

function argStr(args: unknown, key: string): string | undefined {
  if (!args || typeof args !== "object") return undefined;
  const v = (args as Record<string, unknown>)[key];
  return typeof v === "string" && v !== "" ? v : undefined;
}

function argNum(args: unknown, key: string): number | undefined {
  if (!args || typeof args !== "object") return undefined;
  const v = (args as Record<string, unknown>)[key];
  return typeof v === "number" ? v : undefined;
}

const SEVERITIES: readonly SecurityFindingSeverity[] = [
  "critical",
  "high",
  "medium",
  "low",
  "info",
];

function argSeverity(args: unknown): SecurityFindingSeverity | undefined {
  const raw = argStr(args, "severity");
  return SEVERITIES.find((s) => s === raw);
}

/** Error strip + raw result, shared by the family's bodies. */
function ResultStrip({
  result,
  error,
  status,
}: {
  result: unknown;
  error?: string;
  status: "streaming" | "running" | "completed" | "error";
}) {
  if (status === "running" || status === "streaming") {
    return <div className="px-3 py-2 text-[11px] text-muted italic font-mono">running…</div>;
  }
  const text = error || resultText(result);
  if (!text) return null;
  return (
    <div
      className={
        status === "error"
          ? "px-3 py-2 border-t border-danger-500/30 bg-danger-500/5 text-[11px] text-danger-700 dark:text-danger-400 font-mono whitespace-pre-wrap"
          : "px-3 py-2"
      }
    >
      {status === "error" ? text : <TruncatedText text={text} maxLines={10} />}
    </div>
  );
}

/** `sec_dispatch` — the cell card: which cell went out, and a link to the
 * child session parsed from the tool's own result line. */
export const secDispatchRenderer: ToolRenderer = {
  matches: "sec_dispatch",
  category: "write",
  Icon: Boxes,
  formatTarget: (args) => argStr(args, "cell_id") ?? argStr(args, "mode"),
  formatSummary: (_args, result, status) => {
    if (status !== "completed") return undefined;
    const match = /dispatched cell (\S+)/.exec(resultText(result));
    return match?.[1];
  },
  Body: ({ args, result, status, error }) => {
    const text = resultText(result);
    const cellMatch = /dispatched cell (\S+) \(id (\S+), attempt (\d+), mode (\S+)\)/.exec(text);
    const childMatch = /child session (\S+?)\.?(\s|$)/.exec(text);
    const childSessionId = childMatch?.[1];
    return (
      <ToolBody className="px-0 py-0">
        {status === "completed" && cellMatch ? (
          <div className="px-3 py-2 text-[12px] space-y-1">
            <div className="flex items-center gap-2 flex-wrap">
              <span className="font-mono font-medium text-ink">{cellMatch[1]}</span>
              <span className="text-muted">attempt {cellMatch[3]}</span>
              <span className="text-muted">mode {cellMatch[4]}</span>
              {childSessionId && (
                <Link
                  to="/sessions/$sessionId"
                  params={{ sessionId: childSessionId }}
                  className="text-accent-600 dark:text-accent-100 hover:underline"
                >
                  open child session
                </Link>
              )}
            </div>
            {argStr(args, "mode") === "resume" && (
              <div className="text-[11px] text-muted">resumed from the cell's state doc</div>
            )}
          </div>
        ) : (
          <ResultStrip result={result} error={error} status={status} />
        )}
      </ToolBody>
    );
  },
};

/** `sec_finding_report` — severity-badged finding card from the persona's
 * own args (title, file:line); the result line carries the id/fingerprint. */
export const secFindingReportRenderer: ToolRenderer = {
  matches: "sec_finding_report",
  category: "write",
  Icon: ShieldAlert,
  formatTarget: (args) => argStr(args, "title"),
  formatSummary: (args) => argSeverity(args),
  Body: ({ args, result, status, error }) => {
    const severity = argSeverity(args);
    const title = argStr(args, "title");
    const file = argStr(args, "file");
    const line = argNum(args, "line");
    return (
      <ToolBody className="px-0 py-0">
        <div className="px-3 py-2 text-[12px] space-y-1">
          <div className="flex items-center gap-2 flex-wrap">
            {severity && <SeverityBadge severity={severity} />}
            {/* Hostile data: a plain text node, never markdown/HTML. */}
            {title && <span className="font-medium text-ink">{title}</span>}
          </div>
          {file && (
            <div className="font-mono text-muted">
              {file}
              {line !== undefined ? `:${line}` : ""}
            </div>
          )}
        </div>
        <ResultStrip result={result} error={error} status={status} />
      </ToolBody>
    );
  },
};

/** `sec_cell_complete` — the server's ruling, violation text included. */
export const secCellCompleteRenderer: ToolRenderer = {
  matches: "sec_cell_complete",
  category: "edit",
  Icon: CheckCircle2,
  formatTarget: (args) => argStr(args, "cell_id"),
  formatSummary: (_args, result, status) => {
    if (status !== "completed") return undefined;
    return /outcome: (\w+)/.exec(resultText(result))?.[1];
  },
  Body: ({ result, status, error }) => (
    <ToolBody className="px-0 py-0">
      <ResultStrip result={result} error={error} status={status} />
    </ToolBody>
  ),
};

/** The loose shape the `sec_close` result text may parse into. Every field
 * is re-checked before use — the text is agent-relayed data. */
interface ManifestText {
  status?: unknown;
  findings?: {
    total?: unknown;
    distinctBySeverity?: Record<string, unknown>;
    statusBreakdown?: { open?: unknown; verified?: unknown; refuted?: unknown };
  };
}

/** `sec_close` — the manifest summary. The result is the manifest JSON; a
 * parseable one renders as headline counts, anything else as its text. */
export const secCloseRenderer: ToolRenderer = {
  matches: "sec_close",
  category: "edit",
  Icon: FileArchive,
  formatTarget: () => "engagement manifest",
  Body: ({ result, status, error }) => {
    const text = resultText(result);
    let manifest: ManifestText | null = null;
    if (status === "completed" && text.trimStart().startsWith("{")) {
      try {
        const parsed: unknown = JSON.parse(text);
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
          manifest = parsed as ManifestText;
        }
      } catch {
        manifest = null;
      }
    }
    const distinct = manifest?.findings?.distinctBySeverity;
    const breakdown = manifest?.findings?.statusBreakdown;
    return (
      <ToolBody className="px-0 py-0">
        {manifest ? (
          <div className="px-3 py-2 text-[12px] space-y-1">
            <div className="font-medium text-ink">
              Engagement {typeof manifest.status === "string" ? manifest.status : "closed"}
              {typeof manifest.findings?.total === "number"
                ? ` — ${manifest.findings.total} findings`
                : ""}
            </div>
            {distinct && (
              <div className="flex items-center gap-2 flex-wrap">
                {SEVERITIES.map((severity) =>
                  typeof distinct[severity] === "number" && (distinct[severity] as number) > 0 ? (
                    <span key={severity} className="inline-flex items-center gap-1">
                      <SeverityBadge severity={severity} />
                      <span className="tabular-nums">{distinct[severity] as number}</span>
                    </span>
                  ) : null,
                )}
              </div>
            )}
            {breakdown && (
              <div className="text-[11px] text-muted">
                {typeof breakdown.open === "number" ? `${breakdown.open} open` : ""}
                {typeof breakdown.verified === "number" ? ` · ${breakdown.verified} verified` : ""}
                {typeof breakdown.refuted === "number" ? ` · ${breakdown.refuted} refuted` : ""}
              </div>
            )}
          </div>
        ) : (
          <ResultStrip result={result} error={error} status={status} />
        )}
      </ToolBody>
    );
  },
};

/** `sec_start` — the gate/summary line (repo, SHA, cell list). */
export const secStartRenderer: ToolRenderer = {
  matches: "sec_start",
  category: "write",
  Icon: Play,
  formatTarget: () => "start engagement",
  formatSummary: (_args, result, status) => {
    if (status !== "completed") return undefined;
    const text = resultText(result);
    if (text.includes("was not approved")) return "not approved";
    return /\((\d+) cells\)/.exec(text)?.[1]?.concat(" cells");
  },
  Body: ({ result, status, error }) => (
    <ToolBody className="px-0 py-0">
      <ResultStrip result={result} error={error} status={status} />
    </ToolBody>
  ),
};

/** Every other `sec_*` tool (status, plan, fs, handoff, reviews): a compact
 * text body. Registered after the specific renderers above, before the
 * global fallback. */
export const secGenericRenderer: ToolRenderer = {
  matches: (toolName) => toolName.startsWith("sec_"),
  category: "read",
  Icon: ShieldHalf,
  formatTarget: (args) =>
    argStr(args, "path") ??
    argStr(args, "cell_id") ??
    argStr(args, "finding_id") ??
    argStr(args, "prefix"),
  Body: ({ result, status, error }) => (
    <ToolBody className="px-0 py-0">
      <ResultStrip result={result} error={error} status={status} />
    </ToolBody>
  ),
};

export const securityRenderers: ToolRenderer[] = [
  secDispatchRenderer,
  secFindingReportRenderer,
  secCellCompleteRenderer,
  secCloseRenderer,
  secStartRenderer,
  secGenericRenderer,
];
