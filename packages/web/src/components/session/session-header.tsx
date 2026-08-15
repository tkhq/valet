import { useNavigate } from "@tanstack/react-router";
import { useState } from "react";
import { Check, ClipboardCopy, MoreHorizontal, Moon, RefreshCw, Trash2 } from "lucide-react";
import type { Message, SessionDetail } from "@valet/api/wire";
import {
  Badge,
  Button,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
  Spinner,
  Tooltip,
} from "~/components/primitives";
import { useDeleteSession, usePauseSession, useReplaceSandbox, useSetSessionModel } from "~/api/queries";
import { useMe, useOrg } from "~/api/settings";
import { useOrchestratorInfo } from "~/api/orchestrator";
import { ApiError } from "~/api/client";
import type { AgentStatus, ConnectionStatus } from "~/stores/stream";
import { ModelPicker } from "./model-picker";
import { buildTranscript } from "./transcript";
import { cn } from "~/lib/cn";

/** Collapse a workspace path down to a header-friendly badge: any
 * multi-segment path shows only its LAST segment ("ws-19",
 * "my-repo"), except orchestrator-style paths whose last segment is an
 * opaque id ("user-1fony…") — those show the second-to-last segment
 * ("orchestrator") instead. Single-word workspaces pass through. The
 * full path stays discoverable via the header tooltip. */
export function shortenWorkspace(workspace: string): string {
  const parts = workspace.split("/").filter((p) => p.length > 0);
  if (parts.length <= 1) return workspace;
  const lastIsUuidLike = /^(user-|orch-|wf|s_|wfrun_)/.test(parts[parts.length - 1] ?? "");
  return lastIsUuidLike
    ? parts[parts.length - 2] ?? parts[parts.length - 1] ?? workspace
    : parts[parts.length - 1] ?? workspace;
}

/** Server sends `{ error: "a turn is running" }` / `{ error: "sandbox is not
 * ready to pause" }` for the documented 409s (pause and sandbox-replace);
 * fall back to the mutation's own message for anything else (network
 * failure, capability-off 409, unexpected shape). */
function extractActionError(err: unknown, fallback: string): string {
  if (err instanceof ApiError && err.payload && typeof err.payload === "object") {
    const message = (err.payload as Record<string, unknown>).error;
    if (typeof message === "string" && message) return message;
  }
  return err instanceof Error ? err.message : fallback;
}

export function SessionHeader({
  session,
  agentStatus,
  conn,
  sandbox,
  threadId,
  messages,
}: {
  session: SessionDetail;
  agentStatus: AgentStatus;
  conn: ConnectionStatus;
  sandbox?: { state: string; epoch: number };
  threadId?: string;
  messages?: Message[];
}) {
  const navigate = useNavigate();
  const del = useDeleteSession();
  const setModel = useSetSessionModel(session.id);
  const pause = usePauseSession(session.id);
  const replace = useReplaceSandbox(session.id);
  const me = useMe();
  const org = useOrg();
  const orchInfo = useOrchestratorInfo();
  const [actionError, setActionError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  async function destroy() {
    if (
      !confirm(
        "Delete this session permanently? This deletes all threads, history, and child sessions, and tears down the sandbox.",
      )
    )
      return;
    try {
      await del.mutateAsync(session.id);
      navigate({ to: "/" });
    } catch (err) {
      console.error("delete failed:", err);
    }
  }

  async function pauseSession() {
    setActionError(null);
    try {
      await pause.mutateAsync();
    } catch (err) {
      setActionError(extractActionError(err, "Failed to pause session."));
    }
  }

  async function replaceSandbox() {
    setActionError(null);
    try {
      await replace.mutateAsync();
    } catch (err) {
      setActionError(extractActionError(err, "Failed to replace the sandbox."));
    }
  }

  async function copyTranscript() {
    const transcript = buildTranscript({
      session,
      threadId,
      messages: messages ?? [],
      agentStatus,
      conn,
      sandbox,
      user: me.data
        ? { id: me.data.id, email: me.data.email, name: me.data.name }
        : undefined,
      org: me.data
        ? { id: me.data.orgId, name: org.data?.name ?? null }
        : undefined,
      env: {
        origin: typeof window !== "undefined" ? window.location.origin : undefined,
        userAgent: typeof navigator !== "undefined" ? navigator.userAgent : undefined,
      },
    });
    try {
      await navigator.clipboard.writeText(transcript);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    } catch (err) {
      // Clipboard permission denied — fall back to a hidden textarea. This
      // is the sole reason this handler doesn't just await writeText and
      // trust it; some browsers block programmatic clipboard writes.
      const el = document.createElement("textarea");
      el.value = transcript;
      el.style.position = "fixed";
      el.style.opacity = "0";
      document.body.appendChild(el);
      el.select();
      try {
        document.execCommand("copy");
        setCopied(true);
        window.setTimeout(() => setCopied(false), 1500);
      } catch (fallbackErr) {
        console.error("copy transcript failed:", err, fallbackErr);
      } finally {
        document.body.removeChild(el);
      }
    }
  }

  // Single-row masthead. The workspace path lives in a hover tooltip on
  // the title — for orchestrator sessions it's a long internal filesystem
  // path (`/root/.valet/orchestrator/user-…`) that shouted at users from
  // the subtitle before. Real sessions have friendlier workspace names,
  // but hiding both keeps the visual language consistent and lets the
  // action cluster on the right breathe.
  //
  // The orchestrator's title card carries the orchestrator's chosen name
  // (e.g. "Aurora") — the top-nav logo stays "Valet", so this is where
  // the assistant's identity lives.
  const isOrchestrator = session.id.startsWith("orchestrator:");
  const title =
    (isOrchestrator ? orchInfo.data?.name : undefined) || session.title || "Untitled session";
  const workspaceHint = session.workspace ? `workspace: ${session.workspace}` : title;
  return (
    <header className="border-b border-line bg-paper px-4 h-[--nav-height] flex items-center gap-3">
      <Tooltip content={workspaceHint} delayDuration={400}>
        <div className="min-w-0 flex items-baseline gap-2 cursor-default">
          <span className="text-sm font-semibold tracking-tight truncate text-ink font-display">
            {title}
          </span>
          {/* No `uppercase` on the badge — workspace names are
              case-sensitive paths; shouting them in caps misrepresents
              them. */}
          {session.workspace && (
            <span className="text-[10px] font-mono tracking-wide text-muted truncate">
              {shortenWorkspace(session.workspace)}
            </span>
          )}
        </div>
      </Tooltip>
      <div className="ml-auto flex items-center gap-1.5">
        {actionError && <span className="text-xs text-danger-500">{actionError}</span>}
        <Tooltip content="Session-default model. Threads inherit unless overridden.">
          <span>
            <ModelPicker
              currentId={session.model}
              onSelect={(id) => setModel.mutate(id)}
              disabled={setModel.isPending}
            />
          </span>
        </Tooltip>
        <SandboxChip sandbox={sandbox} />
        <ConnectionBadge conn={conn} />
        <AgentStatusBadge status={agentStatus} />
        <Tooltip content={copied ? "Copied to clipboard" : "Copy debug transcript (session/thread + raw tool calls + env)"}>
          <Button
            variant="ghost"
            size="sm"
            onClick={copyTranscript}
            aria-label="Copy transcript"
          >
            {copied ? (
              <Check className="h-4 w-4 text-moss" />
            ) : (
              <ClipboardCopy className="h-4 w-4" />
            )}
          </Button>
        </Tooltip>
        <Tooltip content="Pause session — sandbox sleeps until the next message">
          <Button
            variant="ghost"
            size="sm"
            onClick={pauseSession}
            disabled={sandbox?.state !== "ready" || pause.isPending}
            aria-label="Pause session"
          >
            {pause.isPending ? <Spinner size={14} /> : <Moon className="h-4 w-4" />}
          </Button>
        </Tooltip>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="ghost" size="sm" aria-label="Session menu">
              {del.isPending || replace.isPending ? (
                <Spinner size={14} />
              ) : (
                <MoreHorizontal className="h-4 w-4" />
              )}
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuItem
              disabled={replace.isPending}
              onSelect={() => void replaceSandbox()}
            >
              <RefreshCw className="h-3.5 w-3.5 mr-2" aria-hidden />
              Replace sandbox
            </DropdownMenuItem>
            <DropdownMenuItem
              className="text-danger-500"
              disabled={del.isPending}
              onSelect={() => void destroy()}
            >
              <Trash2 className="h-3.5 w-3.5 mr-2" aria-hidden />
              Delete session…
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </header>
  );
}

function ConnectionBadge({ conn }: { conn: ConnectionStatus }) {
  const map: Record<ConnectionStatus, { label: string; variant: "neutral" | "success" | "danger" }> = {
    idle: { label: "idle", variant: "neutral" },
    connecting: { label: "connecting", variant: "neutral" },
    open: { label: "live", variant: "success" },
    closed: { label: "offline", variant: "neutral" },
    error: { label: "error", variant: "danger" },
  };
  const { label, variant } = map[conn];
  return <Badge variant={variant}>{label}</Badge>;
}

/**
 * Ambient workspace-sandbox indicator: a dot + short label, not a full
 * `Badge` — this is a background signal, not something the user acts on.
 * Renders nothing until the first `sandbox.status` frame arrives (absent =
 * unknown, not "detached") to avoid layout shift / a misleading state.
 */
export function SandboxChip({ sandbox }: { sandbox?: { state: string; epoch: number } }) {
  if (!sandbox) return null;
  const map: Record<string, { dot: string; label: string }> = {
    provisioning: { dot: "bg-amber-500", label: "workspace provisioning…" },
    ready: { dot: "bg-success-500", label: "workspace ready" },
    idle: { dot: "bg-success-500", label: "workspace idle" },
    snapshotting: { dot: "bg-amber-500", label: "workspace snapshotting…" },
    suspended: { dot: "bg-neutral-400", label: "sleeping — will wake on message" },
    released: { dot: "bg-neutral-400", label: "workspace released" },
    error: { dot: "bg-danger-500", label: "workspace error" },
  };
  const entry = map[sandbox.state];
  if (!entry) return null;
  return (
    <Tooltip content={entry.label}>
      <span className="inline-flex items-center gap-1.5 px-1" aria-label={entry.label}>
        <span className={cn("h-1.5 w-1.5 rounded-full", entry.dot)} />
      </span>
    </Tooltip>
  );
}

function AgentStatusBadge({ status }: { status: AgentStatus }) {
  if (status === "idle") return <Badge variant="neutral">idle</Badge>;
  const variant =
    status === "error" ? "danger" : status === "thinking" || status === "tool_calling" ? "accent" : "neutral";
  return (
    <Badge variant={variant} className={cn("inline-flex items-center gap-1.5")}>
      {status !== "queued" && (
        <span className="h-1.5 w-1.5 rounded-full bg-current animate-pulse motion-reduce:animate-none" />
      )}
      {status.replace("_", " ")}
    </Badge>
  );
}
