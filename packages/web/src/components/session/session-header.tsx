import { useNavigate } from "@tanstack/react-router";
import { useState } from "react";
import { Check, ClipboardCopy, Moon, Trash2 } from "lucide-react";
import type { Message, SessionDetail } from "@valet/api/wire";
import { Badge, Button, Spinner, Tooltip } from "~/components/primitives";
import { useDeleteSession, usePauseSession, useSetSessionModel } from "~/api/queries";
import { useMe, useOrg, useTeams } from "~/api/settings";
import { useAssistants } from "~/api/assistants";
import { useOrchestratorInfo } from "~/api/orchestrator";
import { ApiError } from "~/api/client";
import type { AgentStatus, ConnectionStatus } from "~/stores/stream";
import { ModelPicker } from "./model-picker";
import { buildTranscript } from "./transcript";
import { cn } from "~/lib/cn";
import { useCopyToClipboard } from "~/lib/use-copy";
import { formatElapsed, useElapsedSeconds } from "~/lib/use-elapsed";

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
 * ready to pause" }` for the documented 409s (sandbox hibernation plan, Task
 * 4); fall back to the mutation's own message for anything else (network
 * failure, capability-off 409, unexpected shape). */
function extractPauseError(err: unknown): string {
  if (err instanceof ApiError && err.payload && typeof err.payload === "object") {
    const message = (err.payload as Record<string, unknown>).error;
    if (typeof message === "string" && message) return message;
  }
  return err instanceof Error ? err.message : "Failed to pause session.";
}

export function SessionHeader({
  session,
  agentStatus,
  turnStartedAt,
  conn,
  sandbox,
  threadId,
  messages,
}: {
  session: SessionDetail;
  agentStatus: AgentStatus;
  /** Wire timestamp the current turn began; undefined while idle. */
  turnStartedAt?: number;
  conn: ConnectionStatus;
  sandbox?: { state: string; epoch: number };
  threadId?: string;
  messages?: Message[];
}) {
  const navigate = useNavigate();
  const del = useDeleteSession();
  const setModel = useSetSessionModel(session.id);
  const pause = usePauseSession(session.id);
  const me = useMe();
  const org = useOrg();
  const orchInfo = useOrchestratorInfo();
  const teams = useTeams();
  const assistants = useAssistants();
  const [pauseError, setPauseError] = useState<string | null>(null);
  const { copied, copy: copyToClipboard } = useCopyToClipboard();

  async function destroy() {
    // A team's assistant is shared, so the prompt names what everyone else
    // loses rather than describing a private session.
    const prompt =
      teamId !== null
        ? `Delete ${title}? Everyone on ${team?.name ?? "the team"} loses this conversation and its threads.`
        : "Delete session and tear down its sandbox?";
    if (!confirm(prompt)) return;
    try {
      await del.mutateAsync(session.id);
      navigate({ to: "/" });
    } catch (err) {
      console.error("delete failed:", err);
    }
  }

  async function pauseSession() {
    setPauseError(null);
    try {
      await pause.mutateAsync();
    } catch (err) {
      setPauseError(extractPauseError(err));
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
    const ok = await copyToClipboard(transcript);
    if (!ok) console.error("copy transcript failed");
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
  // An assistant is titled with its own name, and a team's assistant falls
  // back to the TEAM's name. Both come from the assistants list rather than
  // from the session id: the id used to be parsed for the owning team, which
  // worked only while a team had exactly one assistant. Narrowing still
  // matters — `orchInfo` is the viewer's OWN assistant, so a bare
  // `startsWith("orchestrator:")` test titled every team assistant with the
  // viewer's personal assistant name.
  const assistant = assistants.data?.assistants.find((a) => a.sessionId === session.id);
  const teamId = assistant?.owner.type === "team" ? assistant.owner.id : null;
  const team = teamId !== null ? teams.data?.teams.find((t) => t.id === teamId) : undefined;
  // Your own assistant is recognised without waiting on the list:
  // `GET /orchestrator/info` answers with the very session id it names.
  const isOwnOrchestrator =
    assistant?.owner.type === "user" || orchInfo.data?.sessionId === session.id;
  const isAssistantSession = assistant !== undefined || isOwnOrchestrator;
  const title =
    assistant?.name ||
    (teamId !== null ? team?.name : undefined) ||
    (isOwnOrchestrator ? orchInfo.data?.name : undefined) ||
    session.title ||
    "Untitled session";

  // Lifecycle controls (model, pause, delete) act on a session the whole
  // team shares, so they are a team-admin power — the API enforces the
  // same rule; this only hides controls that would 404. Personal sessions
  // are unaffected.
  const canAdminister =
    teamId === null || team?.callerRole === "admin" || me.data?.orgRole === "admin";
  const workspaceHint = session.workspace ? `workspace: ${session.workspace}` : title;
  return (
    <header className="border-b border-line bg-paper px-4 h-[--nav-height] flex items-center gap-3">
      <Tooltip content={workspaceHint} delayDuration={400}>
        <div className="min-w-0 flex items-baseline gap-2 cursor-default">
          <span className="text-sm font-semibold tracking-tight truncate text-ink font-display">
            {title}
          </span>
          {/* Deliberately NOT `OwnerBadge`. That badge names the owning team
              and links to its assistant; here the title already IS the team
              name, and its assistant is the page you are on — so it would
              render "Platform [Platform]" pointing at itself. This badge
              answers a different question: whether the conversation you are
              reading is shared. */}
          {teamId !== null && (
            <Badge variant="accent" className="shrink-0">
              Team
            </Badge>
          )}
          {/* An orchestrator's workspace is a synthetic internal directory
              (`~/.valet/orchestrator/{type}-{principalId}`), not a place
              anyone chose or can act on. On a team assistant it rendered as
              `team-team_99235d43-…` — the doubled prefix is the principal
              type joined to an id that already carries it — which is an
              internal identifier shown to a user for no reason. The file's
              own note above says these paths "shouted at users from the
              subtitle"; this is that intent, finally applied to the chip.

              No `uppercase` on the chip when it does render — real
              workspace names are case-sensitive paths, and shouting them in
              caps misrepresents them. */}
          {session.workspace && !isAssistantSession && (
            <span className="text-[10px] font-mono tracking-wide text-muted truncate">
              {shortenWorkspace(session.workspace)}
            </span>
          )}
        </div>
      </Tooltip>
      <div className="ml-auto flex items-center gap-1.5">
        {pauseError && <span className="text-xs text-danger-500">{pauseError}</span>}
        {canAdminister && (
          <Tooltip content="Session-default model. Threads inherit unless overridden.">
            <span>
              <ModelPicker
                currentId={session.model}
                onSelect={(id) => setModel.mutate(id)}
                disabled={setModel.isPending}
              />
            </span>
          </Tooltip>
        )}
        <SandboxChip sandbox={sandbox} />
        <ConnectionBadge conn={conn} />
        <AgentStatusBadge status={agentStatus} turnStartedAt={turnStartedAt} />
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
        {canAdminister && (
          <>
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
            <Tooltip
              content={teamId !== null ? "Delete this team's assistant" : "Delete session"}
            >
              <Button
                variant="ghost"
                size="sm"
                onClick={destroy}
                disabled={del.isPending}
                aria-label="Delete session"
              >
                {del.isPending ? <Spinner size={14} /> : <Trash2 className="h-4 w-4" />}
              </Button>
            </Tooltip>
          </>
        )}
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

function AgentStatusBadge({ status, turnStartedAt }: { status: AgentStatus; turnStartedAt?: number }) {
  const elapsed = useElapsedSeconds(status === "idle" ? undefined : turnStartedAt);
  if (status === "idle") return <Badge variant="neutral">idle</Badge>;
  const variant =
    status === "error" ? "danger" : status === "thinking" || status === "tool_calling" ? "accent" : "neutral";
  return (
    <Badge variant={variant} className={cn("inline-flex items-center gap-1.5 tabular-nums")}>
      {status !== "queued" && (
        <span className="h-1.5 w-1.5 rounded-full bg-current animate-pulse motion-reduce:animate-none" />
      )}
      {status.replace("_", " ")}
      {elapsed !== undefined && <span className="text-current/70">{formatElapsed(elapsed)}</span>}
    </Badge>
  );
}
