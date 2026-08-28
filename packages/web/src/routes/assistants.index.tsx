import { createFileRoute, Link } from "@tanstack/react-router";
import type { AssistantSummary } from "@valet/api/wire";
import { useAssistants } from "~/api/assistants";
import { useMe } from "~/api/settings";
import { assistantLabel } from "~/components/session/assistant-rail";
import { WorkspaceClause } from "~/components/workspace-clause";
import { Badge, Button, ErrorRow, LoadingRow } from "~/components/primitives";
import { errorText } from "~/lib/error-text";
import { useWorkspaceScope } from "~/lib/workspace-scope";

/**
 * `/assistants` — the active workspace's assistants, each opening its
 * editor. The list follows the workspace switcher like every list page;
 * before this page existed the only path to an editor was the chat rail's
 * per-assistant menu. Creating, renaming, and archiving stay in the rail
 * and the editor's Manage section — this page navigates, it does not
 * mutate.
 */
export const Route = createFileRoute("/assistants/")({
  component: AssistantsIndexPage,
});

/** The active workspace's assistants: the team's when a team is scoped,
 * else the caller's own. Exported for tests. */
export function workspaceAssistants(
  assistants: readonly AssistantSummary[],
  scope: { teamId: string | undefined },
  meId: string | undefined,
): AssistantSummary[] {
  if (scope.teamId !== undefined) {
    return assistants.filter((a) => a.owner.type === "team" && a.owner.id === scope.teamId);
  }
  return assistants.filter((a) => a.owner.type === "user" && a.owner.id === meId);
}

export function AssistantsIndexPage() {
  const scope = useWorkspaceScope();
  const assistantsQ = useAssistants();
  const meQ = useMe();

  const rows =
    assistantsQ.data === undefined || meQ.data === undefined
      ? undefined
      : workspaceAssistants(assistantsQ.data.assistants, scope, meQ.data.id);

  return (
    <div className="flex-1 overflow-y-auto">
      <div className="mx-auto max-w-3xl space-y-6 px-6 py-10">
        <div className="flex items-baseline gap-3">
          <h1 className="font-display text-2xl text-ink">Assistants</h1>
          <WorkspaceClause />
        </div>

        {assistantsQ.error != null || meQ.error != null ? (
          <div className="space-y-2">
            <ErrorRow>
              Could not load assistants: {errorText(assistantsQ.error ?? meQ.error)}
            </ErrorRow>
            <Button
              type="button"
              variant="secondary"
              onClick={() => {
                void assistantsQ.refetch?.();
                void meQ.refetch?.();
              }}
            >
              Retry
            </Button>
          </div>
        ) : rows === undefined ? (
          <LoadingRow />
        ) : rows.length === 0 ? (
          <p className="rounded-lg border border-line px-4 py-6 text-sm text-muted">
            No assistants in this workspace yet. Create one from the sidebar on the Chat page.
          </p>
        ) : (
          <ul className="divide-y divide-line overflow-hidden rounded-lg border border-line">
            {rows.map((a) => {
              const label = a.name?.trim() || assistantLabel(a);
              return (
                <li key={a.id}>
                  <Link
                    to="/assistants/$assistantId"
                    params={{ assistantId: a.id }}
                    className="flex items-center gap-3 px-4 py-3 hover:bg-ink-wash"
                  >
                    <span
                      aria-hidden
                      className="grid h-9 w-9 shrink-0 place-items-center rounded-lg bg-moss-wash font-display text-sm font-semibold text-moss"
                    >
                      {label.charAt(0).toUpperCase()}
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="flex items-center gap-2">
                        <span className="truncate text-sm font-medium text-ink">{label}</span>
                        {a.isDefault && <Badge variant="accent">Default</Badge>}
                      </span>
                      {a.personality && (
                        <span className="block truncate text-xs text-muted">{a.personality}</span>
                      )}
                    </span>
                    <span className="shrink-0 text-xs text-muted">Edit →</span>
                  </Link>
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </div>
  );
}
