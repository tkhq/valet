import { useNavigate } from "@tanstack/react-router";
import { Trash2 } from "lucide-react";
import type { SessionDetail } from "@valet/api/wire";
import { Badge, Button, Spinner, Tooltip } from "~/components/primitives";
import { useDeleteSession, useSetSessionModel } from "~/api/queries";
import type { AgentStatus, ConnectionStatus } from "~/stores/stream";
import { ModelPicker } from "./model-picker";
import { cn } from "~/lib/cn";

export function SessionHeader({
  session,
  agentStatus,
  conn,
  sandbox,
}: {
  session: SessionDetail;
  agentStatus: AgentStatus;
  conn: ConnectionStatus;
  sandbox?: { state: string; epoch: number };
}) {
  const navigate = useNavigate();
  const del = useDeleteSession();
  const setModel = useSetSessionModel(session.id);

  async function destroy() {
    if (!confirm(`Delete session and tear down its sandbox?`)) return;
    try {
      await del.mutateAsync(session.id);
      navigate({ to: "/" });
    } catch (err) {
      console.error("delete failed:", err);
    }
  }

  return (
    <header className="border-b border-line bg-paper px-4 py-3 flex items-center gap-3">
      <div className="min-w-0">
        <div className="text-sm font-semibold tracking-tight truncate text-ink">
          {session.title || "Untitled session"}
        </div>
        <div className="text-xs text-muted font-mono truncate">{session.workspace}</div>
      </div>
      <div className="ml-auto flex items-center gap-2">
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
        <Tooltip content="Delete session">
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
