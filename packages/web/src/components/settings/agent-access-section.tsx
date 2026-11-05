import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { api } from "~/api/client";
import { Button } from "~/components/primitives";

/**
 * The MCP apps and `valet login` CLIs that can act as you, each with a
 * Disconnect button (`routes/agent-access.ts`). Disconnecting deletes the
 * tokens, so the app or CLI stops working at once and must sign in again.
 */
const KEY = ["agent-access"] as const;

function day(ms: number | null): string {
  return ms === null ? "unknown" : new Date(ms).toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
}

export function AgentAccessSection() {
  const access = useQuery({ queryKey: KEY, queryFn: () => api.agentAccess() });
  const qc = useQueryClient();
  const disconnect = useMutation({
    mutationFn: (target: { kind: "mcp" | "cli"; id: string }) =>
      target.kind === "mcp" ? api.disconnectMcpApp(target.id) : api.disconnectCliDevice(target.id),
    onSettled: () => qc.invalidateQueries({ queryKey: KEY }),
  });

  if (access.error) return <p role="alert" className="text-sm text-danger-500">Could not load agent access. Reload this page to try again.</p>;
  if (!access.data) return <p role="status" className="text-sm text-muted">Loading agent access…</p>;
  const { mcp_apps: apps, cli_devices: clis } = access.data;

  return (
    <div className="space-y-8">
      <SetupCard />
      <div className="space-y-2">
        <h3 className="text-sm font-medium text-ink">MCP apps</h3>
        {apps.length === 0 ? (
          <p className="text-sm text-muted">No apps are connected. An agent such as Claude Code connects through {"/mcp"} and asks for your approval.</p>
        ) : (
          <div className="divide-y divide-line border-t border-line">
            {apps.map((app) => (
              <AccessRow
                key={app.client_id}
                title={app.name}
                detail={`Connected ${day(app.connected_at)}`}
                pending={disconnect.isPending && disconnect.variables?.id === app.client_id}
                onDisconnect={() => disconnect.mutate({ kind: "mcp", id: app.client_id })}
              />
            ))}
          </div>
        )}
      </div>
      <div className="space-y-2">
        <h3 className="text-sm font-medium text-ink">Valet CLI</h3>
        {clis.length === 0 ? (
          <p className="text-sm text-muted">No CLI is signed in. Run <code>valet login</code> on a computer to sign one in.</p>
        ) : (
          <div className="divide-y divide-line border-t border-line">
            {clis.map((cli) => (
              <AccessRow
                key={cli.id}
                title={cli.device}
                detail={`Signed in ${day(cli.signed_in_at)} · last used ${day(cli.last_used_at)}`}
                pending={disconnect.isPending && disconnect.variables?.id === cli.id}
                onDisconnect={() => disconnect.mutate({ kind: "cli", id: cli.id })}
              />
            ))}
          </div>
        )}
      </div>
      {disconnect.error && <p role="alert" className="text-sm text-danger-500">Could not disconnect. Reload this page and try again.</p>}
    </div>
  );
}

function AccessRow({ title, detail, pending, onDisconnect }: { title: string; detail: string; pending: boolean; onDisconnect: () => void }) {
  // Two clicks, without a browser dialog: the first asks, the second disconnects.
  const [confirming, setConfirming] = useState(false);
  return (
    <div className="flex items-center justify-between gap-4 py-3">
      <div className="min-w-0">
        <p className="truncate text-sm text-ink">{title}</p>
        <p className="text-xs text-muted">{detail}</p>
      </div>
      <Button
        size="sm"
        variant={confirming ? "danger" : "secondary"}
        disabled={pending}
        onClick={() => (confirming ? onDisconnect() : setConfirming(true))}
        onBlur={() => setConfirming(false)}
      >
        {confirming ? "Confirm disconnect" : "Disconnect"}
      </Button>
    </div>
  );
}

/**
 * How to connect a coding agent: one sentence the person pastes into it. The
 * agent then follows `/agent-setup.md`, which runs `valet login` and
 * `valet mcp setup` and asks the person to approve each in the browser.
 */
function SetupCard() {
  const instruction = `Read ${window.location.origin}/agent-setup.md and follow it.`;
  const [copied, setCopied] = useState(false);
  async function copy() {
    try {
      await navigator.clipboard.writeText(instruction);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // Clipboard access can be refused; the text stays selectable.
    }
  }
  return (
    <div className="space-y-2 rounded border border-line px-4 py-3">
      <h3 className="text-sm font-medium text-ink">Set up a coding agent</h3>
      <p className="text-sm text-muted">
        To connect Claude Code, Codex, or Cursor, paste this into the agent. It installs the Valet CLI, connects MCP, and asks you to approve each step in the browser.
      </p>
      <div className="flex items-center gap-2">
        <code className="min-w-0 flex-1 select-all truncate rounded bg-neutral-100 px-2 py-1.5 text-xs text-ink dark:bg-neutral-800">{instruction}</code>
        <Button size="sm" variant="secondary" onClick={() => void copy()}>
          {copied ? "Copied" : "Copy"}
        </Button>
      </div>
    </div>
  );
}
