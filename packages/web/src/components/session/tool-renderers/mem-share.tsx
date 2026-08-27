import { Check, Copy, Share2 } from "lucide-react";
import { useCopyToClipboard } from "~/lib/use-copy";
import { PathLabel, ToolBody } from "./tool-shell";
import { resultText, type ToolRenderer } from "./types";

/**
 * Renderer for the orchestrator's `mem_share` tool (artifacts design).
 * The fallback renderer shows the result as inert monospace text, which
 * left the share URL — the whole point of the call — unclickable. This
 * renderer parses the tool's result line and presents the link with a
 * copy button and the audience statement.
 */

/** Pure: mem_share result text → parsed share, or null when the text is
 * not the `shared <path> → <url>` shape (revokes, errors). */
export function parseShareResult(text: string): { url: string; audience: string | null } | null {
  const match = text.match(/^shared .+ → (https?:\/\/\S+)/m);
  if (!match) return null;
  const audience = text.match(/^Audience: (.+)$/m);
  return { url: match[1], audience: audience ? audience[1] : null };
}

function getArgs(args: unknown): { path: string; revoke: boolean } {
  if (!args || typeof args !== "object") return { path: "", revoke: false };
  const a = args as { path?: unknown; revoke?: unknown };
  return {
    path: typeof a.path === "string" ? a.path : "",
    revoke: a.revoke === true,
  };
}

function CopyButton({ value }: { value: string }) {
  const { copied, copy } = useCopyToClipboard();
  return (
    <button
      type="button"
      onClick={() => void copy(value)}
      className="rounded p-1 text-muted hover:text-moss"
      aria-label="Copy share link"
    >
      {copied ? <Check className="h-3.5 w-3.5" aria-hidden /> : <Copy className="h-3.5 w-3.5" aria-hidden />}
    </button>
  );
}

export const memShareRenderer: ToolRenderer = {
  matches: "mem_share",
  category: "write",
  Icon: Share2,
  formatTarget: (args) => getArgs(args).path || undefined,
  formatSummary: (args, result, status) => {
    if (status !== "completed") return undefined;
    if (getArgs(args).revoke) return "revoked";
    return parseShareResult(resultText(result)) ? "shared" : undefined;
  },
  Body: ({ args, status, result, error }) => {
    const { revoke, path } = getArgs(args);
    const text = resultText(result);

    if (status === "running") {
      return (
        <ToolBody>
          <span className="text-muted italic font-mono text-[11px]">{revoke ? "revoking…" : "sharing…"}</span>
        </ToolBody>
      );
    }
    const share = status === "completed" ? parseShareResult(text) : null;
    if (!share) {
      // Revoke confirmations and errors are one plain line each.
      return (
        <ToolBody>
          <span className="text-muted font-mono text-[11px]">{error || text || "(empty)"}</span>
        </ToolBody>
      );
    }
    return (
      <ToolBody className="space-y-1.5">
        <div className="flex items-center gap-2">
          <PathLabel path={path} />
          <a
            href={share.url}
            target="_blank"
            rel="noopener noreferrer"
            className="min-w-0 truncate font-mono text-[11px] text-moss hover:underline"
          >
            {share.url}
          </a>
          <CopyButton value={share.url} />
        </div>
        {share.audience && <p className="text-[11px] text-muted">{share.audience}</p>}
      </ToolBody>
    );
  },
};
