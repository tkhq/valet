import { useNavigate } from "@tanstack/react-router";
import { useRef, useState } from "react";
import {
  Check,
  ClipboardCopy,
  MoreHorizontal,
  Moon,
  RefreshCw,
  SquareTerminal,
  Trash2,
} from "lucide-react";
import type { Message, SessionDetail } from "@valet/api/wire";
import {
  Badge,
  Button,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
  Input,
  Spinner,
  Tooltip,
} from "~/components/primitives";
import {
  useDeleteSession,
  usePauseSession,
  useRenameSession,
  useReplaceSandbox,
  useSetSessionModel,
  useSetSessionProfile,
} from "~/api/queries";
import { useMe, useOrg, useTeams } from "~/api/settings";
import { useAssistants } from "~/api/assistants";
import { useOrchestratorInfo } from "~/api/orchestrator";
import { ApiError } from "~/api/client";
import { queueBusy, useQueueStateForThread, type AgentStatus, type ConnectionStatus } from "~/stores/stream";
import { assistantLabel } from "./assistant-rail";
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
  const replace = useReplaceSandbox(session.id);
  const rename = useRenameSession(session.id);
  const setProfile = useSetSessionProfile(session.id);
  const me = useMe();
  const org = useOrg();
  const orchInfo = useOrchestratorInfo();
  const teams = useTeams();
  const assistants = useAssistants();
  // One error slot for every header action: pause, replace, rename, and the
  // Terminal/VS Code switch.
  const [actionError, setActionError] = useState<string | null>(null);
  // Durable busy fallback for the status badge — same signal the composer's
  // Stop/Escape affordance uses. Without it, a page that connects mid-turn
  // shows "idle" next to a visible Stop button until the next status event.
  const threadBusy = queueBusy(useQueueStateForThread(session.id, threadId));
  const { copied, copy: copyToClipboard } = useCopyToClipboard();
  const [editingTitle, setEditingTitle] = useState(false);
  const [titleDraft, setTitleDraft] = useState("");
  // Enter and blur both reach `commitRename`, and Enter unmounts the input,
  // which fires blur straight after. The ref makes the commit idempotent so
  // one edit sends one PATCH.
  const editOpen = useRef(false);

  async function destroy() {
    // A team's assistant is shared, so the prompt names what everyone else
    // loses rather than describing a private session.
    const prompt =
      teamId !== null
        ? `Delete ${title}? Everyone on ${team?.name ?? "the team"} loses this conversation and its threads.`
        : "Delete this session permanently? This deletes all threads, history, and child sessions, and tears down the sandbox.";
    if (!confirm(prompt)) return;
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

  // The profile decides whether the sandbox starts a terminal server and a
  // VS Code server. It is baked into the container at create time, so the
  // switch restarts the sandbox. Name that cost before doing it — the
  // workspace files survive, an open terminal does not.
  async function toggleInteractiveServices() {
    const turningOn = session.profile !== "full";
    const prompt = turningOn
      ? "Turn on Terminal and VS Code? The workspace sandbox restarts now. Your files are kept. Anything open in a terminal is lost."
      : "Turn off Terminal and VS Code? The workspace sandbox restarts now. Your files are kept. Anything open in a terminal is lost.";
    if (!confirm(prompt)) return;
    setActionError(null);
    try {
      await setProfile.mutateAsync(turningOn ? "full" : "headless");
    } catch (err) {
      setActionError(
        extractActionError(err, "Failed to change the session's services. Try again."),
      );
    }
  }

  function beginRename() {
    setActionError(null);
    setTitleDraft(session.title ?? "");
    editOpen.current = true;
    setEditingTitle(true);
  }

  function cancelRename() {
    editOpen.current = false;
    setEditingTitle(false);
  }

  async function commitRename() {
    if (!editOpen.current) return;
    editOpen.current = false;
    setEditingTitle(false);
    const next = titleDraft.trim();
    // An empty box and an unchanged name both mean "leave it alone". The
    // server rejects an empty title, so do not send one.
    if (next.length === 0 || next === (session.title ?? "")) return;
    setActionError(null);
    try {
      await rename.mutateAsync(next);
    } catch (err) {
      setActionError(extractActionError(err, "Failed to rename the session. Try again."));
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
  // The owning team comes from the assistants list rather than from the
  // session id: the id used to be parsed for it, which worked only while a
  // team had exactly one assistant. Narrowing still matters — `orchInfo` is
  // the viewer's OWN assistant, so a bare `startsWith("orchestrator:")` test
  // titled every team assistant with the viewer's personal assistant name.
  const assistant = assistants.data?.assistants.find((a) => a.sessionId === session.id);
  const teamId = assistant?.owner.type === "team" ? assistant.owner.id : null;
  const team = teamId !== null ? teams.data?.teams.find((t) => t.id === teamId) : undefined;
  // Your own assistant is recognised without waiting on the list:
  // `GET /orchestrator/info` answers with the very session id it names.
  const isOwnOrchestrator =
    assistant?.owner.type === "user" || orchInfo.data?.sessionId === session.id;
  const isAssistantSession = assistant !== undefined || isOwnOrchestrator;
  // `assistantLabel` is the SAME function the rail uses, so the row you
  // clicked and the header you land on cannot disagree. They did: an
  // assistant nobody has named showed as "Default assistant" in the rail and
  // as the owning TEAM's name here, which read as two different things.
  //
  // The team name is no longer a fallback for a nameless assistant. It named
  // the wrong entity — a team owns assistants, it is not one — and the badge
  // beside this title already says which team the conversation belongs to.
  const title =
    (assistant ? assistantLabel(assistant) : undefined) ||
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
  // Renaming writes `session.title`, so it is offered only where the header
  // actually shows that field. An assistant's header shows the assistant's
  // own name instead, which is renamed on the assistants surface — an edit
  // box here would store a string nobody ever sees.
  const canRename = canAdminister && !isAssistantSession;

  // The edit box replaces the title cluster. The right-hand side keeps the
  // read-only signals — sandbox, connection, agent status — and the error
  // slot, so the row does not jump and a failed rename still has somewhere
  // to report. The action buttons are dropped while editing: they act on a
  // session the person is in the middle of naming.
  if (editingTitle) {
    return (
      <header className="border-b border-line bg-paper px-4 h-[--nav-height] flex items-center gap-3">
        <form
          className="min-w-0"
          onSubmit={(e) => {
            e.preventDefault();
            void commitRename();
          }}
        >
          <Input
            autoFocus
            aria-label="Session title"
            className="h-7 w-64 text-sm font-semibold"
            value={titleDraft}
            onChange={(e) => setTitleDraft(e.target.value)}
            onBlur={() => void commitRename()}
            onKeyDown={(e) => {
              if (e.key === "Escape") {
                e.preventDefault();
                cancelRename();
              }
            }}
          />
        </form>
        <span className="text-xs text-muted shrink-0 hidden sm:inline">
          Enter to save, Esc to cancel
        </span>
        <div className="ml-auto flex items-center gap-1.5">
          {actionError && <span className="text-xs text-danger-500">{actionError}</span>}
          <SandboxChip sandbox={sandbox} />
          <ConnectionBadge conn={conn} />
          <AgentStatusBadge status={agentStatus} turnStartedAt={turnStartedAt} queueBusy={threadBusy} />
        </div>
      </header>
    );
  }

  return (
    <header className="border-b border-line bg-paper px-4 h-[--nav-height] flex items-center gap-3">
      <Tooltip content={workspaceHint} delayDuration={400}>
        <div className="min-w-0 flex items-baseline gap-2 cursor-default">
          {canRename ? (
            <button
              type="button"
              onClick={beginRename}
              aria-label={`Rename session: ${title}`}
              className="text-sm font-semibold tracking-tight truncate text-ink font-display rounded px-0.5 -mx-0.5 hover:bg-line/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-500/40"
            >
              {rename.isPending ? <Spinner size={14} /> : title}
            </button>
          ) : (
            <span className="text-sm font-semibold tracking-tight truncate text-ink font-display">
              {title}
            </span>
          )}
          {/* Names the owning team, now that the title does not.

              This badge used to read the bare word "Team", because the title
              was the team's name and "Platform [Platform]" says one thing
              twice. The title is the assistant's own label now — the same
              label the rail shows — so the team name would otherwise appear
              nowhere in this row, and "Team" alone cannot answer WHICH team
              a person with several is reading.

              Still not `OwnerBadge`: that one links to the team's assistant,
              which is the page you are already on. */}
          {teamId !== null && (
            // The test hook lets a test assert THIS element rather than the
            // team's name appearing anywhere in the header, which a title
            // regression could satisfy on its own.
            <Badge variant="accent" className="shrink-0" data-testid="owning-team">
              {team?.name ?? "Team"}
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
        {actionError && <span className="text-xs text-danger-500">{actionError}</span>}
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
        <AgentStatusBadge status={agentStatus} turnStartedAt={turnStartedAt} queueBusy={threadBusy} />
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
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="ghost" size="sm" aria-label="Session menu">
                  {del.isPending || replace.isPending || setProfile.isPending ? (
                    <Spinner size={14} />
                  ) : (
                    <MoreHorizontal className="h-4 w-4" />
                  )}
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                <DropdownMenuItem
                  disabled={setProfile.isPending}
                  onSelect={() => void toggleInteractiveServices()}
                >
                  <SquareTerminal className="h-3.5 w-3.5 mr-2" aria-hidden />
                  {session.profile === "full"
                    ? "Turn off Terminal and VS Code…"
                    : "Turn on Terminal and VS Code…"}
                </DropdownMenuItem>
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
                  {teamId !== null ? "Delete this team's assistant…" : "Delete session…"}
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
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

function AgentStatusBadge({
  status,
  turnStartedAt,
  queueBusy = false,
}: {
  status: AgentStatus;
  turnStartedAt?: number;
  /**
   * Durable fallback: the thread's queue holds an abortable submission. When
   * the live `status` still reads idle (mid-turn connect before the seed
   * frame, or a dropped event), the badge shows a generic "working" instead
   * of a false "idle".
   */
  queueBusy?: boolean;
}) {
  const busy = status !== "idle" || queueBusy;
  const elapsed = useElapsedSeconds(busy ? turnStartedAt : undefined);
  if (!busy) return <Badge variant="neutral">idle</Badge>;
  const label = status === "idle" ? "working" : status.replace("_", " ");
  const variant =
    status === "error"
      ? "danger"
      : status === "thinking" || status === "tool_calling" || status === "idle"
        ? "accent"
        : "neutral";
  return (
    <Badge variant={variant} className={cn("inline-flex items-center gap-1.5 tabular-nums")}>
      {status !== "queued" && (
        <span className="h-1.5 w-1.5 rounded-full bg-current animate-pulse motion-reduce:animate-none" />
      )}
      {label}
      {elapsed !== undefined && <span className="text-current/70">{formatElapsed(elapsed)}</span>}
    </Badge>
  );
}
