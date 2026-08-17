import { useState } from "react";
import { Link, useNavigate, useSearch } from "@tanstack/react-router";
import { Bot, MoreHorizontal, Plus, Users } from "lucide-react";
import type { AssistantOwner, AssistantSummary, TeamSummary } from "@valet/api/wire";
import {
  useArchiveAssistant,
  useAssistants,
  useCreateAssistant,
  usePatchAssistant,
} from "~/api/assistants";
import { useNotifications } from "~/api/queries";
import { attentionSessionIds } from "~/lib/use-attention-ping";
import { useMe, useOrg, useTeams } from "~/api/settings";
import {
  Button,
  ConfirmDialog,
  Dialog,
  DialogContent,
  DialogFooter,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
  Input,
  Tooltip,
} from "~/components/primitives";
import { errorText } from "~/lib/error-text";
import { cn } from "~/lib/cn";
import { useWorkspaceScope } from "~/lib/workspace-scope";
import { ThreadTree } from "./thread-tree";

/**
 * The `/chat` sidebar: every assistant you can talk to, grouped by who owns
 * it, then the threads of whichever one is active.
 *
 * A team's assistant used to be reachable only through Settings ›
 * Organization › Teams — a configuration screen, three clicks deep, behind
 * an org-admin gate that most members fail. Teams are not a setting; they
 * are how work is addressed. So each team you belong to gets a permanent
 * group here, as a sibling of your own, and finding your team's assistant is
 * the same act as finding your own.
 *
 * Rows are plain links. Their session ids come from `GET /api/assistants`
 * (`AssistantSummary.sessionId`), which the rail must call anyway to show
 * more than one assistant per owner — so browsing the rail still creates
 * nothing, and `/chat` still materializes a session only when someone opens
 * the conversation. The client used to derive the id instead
 * (`lib/orchestrator-id.ts`, now deleted); that scheme could address one
 * assistant per principal and no more.
 */
export function AssistantRail() {
  const orgQ = useOrg();
  const teamsQ = useTeams();
  const meQ = useMe();
  const assistantsQ = useAssistants();
  // `strict: false` reads the search of whatever route is mounted, so its
  // type is the union of every route's — the cast names the one key this
  // component reads. Validation of the value stays in `routes/chat.tsx`.
  const search = (useSearch({ strict: false }) ?? {}) as { assistant?: string };
  const navigate = useNavigate();

  const teams = eligibleTeams(teamsQ.data?.teams, orgQ.data?.features.organizations);
  const groups = groupAssistants(assistantsQ.data?.assistants, teams);
  const total = countAssistants(groups);

  // No-flash rule (same as `settings-rail.tsx`): every query the block reads
  // must resolve before it can appear. A section that renders and then
  // vanishes is worse than one that arrives a beat late.
  const resolved =
    orgQ.data !== undefined && teamsQ.data !== undefined && assistantsQ.data !== undefined;
  // A switcher with one row switches nothing, so it is not drawn. This is
  // what keeps a solo user with one assistant on exactly the sidebar they
  // had before a principal could own several.
  const showAssistants = resolved && total > 1;

  // Only an assistant the caller can actually reach may drive the thread
  // tree — a stale or hand-edited `?assistant=` falls back to your own
  // default rather than rendering a session the viewer cannot read.
  const active = findAssistant(groups, search.assistant) ?? ownDefaultAssistant(groups);

  // Costs no request: the bell is already polling this query.
  const notificationsQ = useNotifications();
  const needsAttention = attentionSessionIds(notificationsQ.data?.notifications);
  // One workspace at a time. The switcher beside the logo chooses it, and
  // the workspace scope names it — and on `/chat` the scope follows the open
  // assistant — so the rail draws exactly the group the open conversation
  // belongs to.
  //
  // This is what retired the row cap. Every owner's assistants used to share
  // this column, so the block grew with the number of teams (42% of the
  // sidebar at nine) and needed a budget, a fair-share pass and a "Show N
  // more" control to stay bounded. Scoping to one workspace bounds it by
  // construction: the block is as tall as one owner's assistant list,
  // whether you belong to two teams or twenty.
  const scope = useWorkspaceScope();
  const shown = groups.filter((g) => g.key === scope.key);

  const [renaming, setRenaming] = useState<AssistantSummary | null>(null);
  const [archiving, setArchiving] = useState<AssistantSummary | null>(null);
  const orgAdmin = meQ.data?.orgRole === "admin";

  return (
    <>
      {assistantsQ.error != null && (
        <div className="border-b border-line px-4 py-2 text-xs text-danger-500">
          Cannot load your assistants. Reload the page.
        </div>
      )}
      {showAssistants && (
        <div className="border-b border-line pb-2 pt-2">
          {shown.map((group) => (
            <AssistantGroupBlock
              key={group.key}
              group={group}
              activeId={active?.id}
              needsAttention={needsAttention}
              canAdminister={canAdministerGroup(group, orgAdmin)}
              onRename={setRenaming}
              onArchive={setArchiving}
            />
          ))}
        </div>
      )}
      {/* Children are deliberately omitted on every assistant but your own
          default: `GET /api/orchestrator/children` resolves the CALLER's own
          orchestrator, so rendering them elsewhere would nest your personal
          child sessions under another assistant's threads — wrong, not
          merely absent. Threads themselves work fully. */}
      {active ? (
        <ThreadTree sessionId={active.sessionId} showChildren={isOwnDefault(active)} />
      ) : (
        <ThreadTree />
      )}
      {renaming && (
        <RenameAssistantDialog
          key={renaming.id}
          assistant={renaming}
          onClose={() => setRenaming(null)}
        />
      )}
      {archiving && (
        <ArchiveAssistantDialog
          key={archiving.id}
          assistant={archiving}
          onClose={() => setArchiving(null)}
          onArchived={() => {
            setArchiving(null);
            // The archived row is gone from the rail. If it was the open
            // conversation, drop back to your own default rather than
            // leaving the page pointed at a session the list no longer
            // carries.
            if (archiving.id === active?.id) {
              navigate({
                to: "/chat",
                search: { assistant: undefined, thread: undefined, child: undefined },
              });
            }
          }}
        />
      )}
    </>
  );
}

/** An owner and the assistants it owns, in the order the rail draws them. */
export interface AssistantGroup {
  /** Stable react key: `user` for your own, else the team id. */
  key: string;
  /** Section header. Your own group says so; a team group is its name. */
  label: string;
  /** Absent for your own group. Carries the member count and caller role. */
  team?: TeamSummary;
  assistants: AssistantSummary[];
}

export function countAssistants(groups: AssistantGroup[]): number {
  return groups.reduce((n, group) => n + group.assistants.length, 0);
}

/**
 * The assistants the rail can draw, grouped by owner: yours first, then one
 * group per team you belong to, in the order `GET /api/teams` gave them.
 *
 * A team-owned assistant is kept only when its team is one you may open
 * (`eligibleTeams`), so an org admin who merely administers a team does not
 * get its assistant in their own sidebar. Org-owned assistants are dropped:
 * no route creates one, and a group whose header nothing can name is worse
 * than a row that is not there.
 *
 * A user-owned assistant is yours by definition — the API returns only the
 * assistants you can view, and a user's assistant is visible to that user
 * alone.
 */
export function groupAssistants(
  assistants: AssistantSummary[] | undefined,
  teams: TeamSummary[],
): AssistantGroup[] {
  if (assistants === undefined) return [];
  const groups: AssistantGroup[] = [];

  const own = assistants.filter((a) => a.owner.type === "user");
  if (own.length > 0) groups.push({ key: "user", label: "Your assistants", assistants: own });

  for (const team of teams) {
    const owned = assistants.filter((a) => a.owner.type === "team" && a.owner.id === team.id);
    if (owned.length > 0) groups.push({ key: team.id, label: team.name, team, assistants: owned });
  }
  return groups;
}

/** The assistant `?assistant=` names, or undefined when it names one the
 * caller cannot reach. */
export function findAssistant(
  groups: AssistantGroup[],
  assistantId: string | undefined,
): AssistantSummary | undefined {
  if (assistantId === undefined) return undefined;
  for (const group of groups) {
    const found = group.assistants.find((a) => a.id === assistantId);
    if (found) return found;
  }
  return undefined;
}

/** Your own default — what `/chat` opens when nothing is selected, and what
 * an unreachable `?assistant=` falls back to. */
export function ownDefaultAssistant(groups: AssistantGroup[]): AssistantSummary | undefined {
  const own = groups.find((group) => group.key === "user")?.assistants ?? [];
  return own.find((a) => a.isDefault) ?? own[0];
}

/** What the row is called. An assistant nobody has named says so, rather
 * than borrowing a name the user never chose. */
export function assistantLabel(assistant: AssistantSummary): string {
  const name = assistant.name?.trim();
  if (name) return name;
  return assistant.isDefault ? "Default assistant" : "Untitled assistant";
}

function isOwnDefault(assistant: AssistantSummary): boolean {
  return assistant.owner.type === "user" && assistant.isDefault;
}

/** Creating, renaming and archiving follow the same rule as administering a
 * session: your own for a user assistant, team admin (or org admin) for a
 * team's. The API enforces it; this only hides controls that would 403. */
export function canAdministerGroup(group: AssistantGroup, orgAdmin: boolean): boolean {
  if (group.team === undefined) return true;
  return orgAdmin || group.team.callerRole === "admin";
}

/** Teams whose assistants the caller may open: the org feature gate is on,
 * and they are a member. An org admin sees every team in the org from
 * `GET /api/teams`, so membership alone is not the test — `callerRole` is
 * null for a team they only administer. */
export function eligibleTeams(
  teams: TeamSummary[] | undefined,
  organizationsEnabled: boolean | undefined,
): TeamSummary[] {
  if (organizationsEnabled !== true) return [];
  return (teams ?? []).filter((t) => t.callerRole !== null);
}

function AssistantGroupBlock({
  group,
  activeId,
  needsAttention,
  canAdminister,
  onRename,
  onArchive,
}: {
  group: AssistantGroup;
  activeId: string | undefined;
  needsAttention: ReadonlySet<string>;
  canAdminister: boolean;
  onRename: (assistant: AssistantSummary) => void;
  onArchive: (assistant: AssistantSummary) => void;
}) {
  const create = useCreateAssistant();
  const navigate = useNavigate();
  const owner: AssistantOwner | undefined =
    group.team === undefined ? undefined : { type: "team", id: group.team.id };

  function createAssistant() {
    create.mutate(
      { owner },
      {
        // A new assistant exists to be talked to, so opening it is the
        // completion of the action, not a second step.
        onSuccess: (assistant) =>
          navigate({
            to: "/chat",
            search: { assistant: assistant.id, thread: undefined, child: undefined },
          }),
      },
    );
  }

  return (
    <div className="pb-1">
      <div className="flex items-center gap-1 px-4 pb-1">
        <p className="min-w-0 flex-1 truncate text-[10px] font-medium uppercase tracking-wider text-muted">
          {group.label}
        </p>
        {canAdminister && (
          <Tooltip content={`New assistant for ${group.label}`} delayDuration={600}>
            <button
              type="button"
              onClick={createAssistant}
              disabled={create.isPending}
              aria-label={`New assistant for ${group.label}`}
              className="shrink-0 rounded p-0.5 text-muted transition-colors hover:bg-ink-wash hover:text-ink focus-visible:bg-ink-wash focus-visible:outline-none disabled:opacity-50"
            >
              <Plus className="h-3 w-3" aria-hidden />
            </button>
          </Tooltip>
        )}
      </div>
      {create.error != null && (
        <p className="px-4 pb-1 text-xs text-danger-500">{errorText(create.error)}</p>
      )}
      {group.assistants.map((assistant) => (
        <AssistantRow
          key={assistant.id}
          assistant={assistant}
          group={group}
          active={assistant.id === activeId}
          needsYou={needsAttention.has(assistant.sessionId)}
          canAdminister={canAdminister}
          onRename={() => onRename(assistant)}
          onArchive={() => onArchive(assistant)}
        />
      ))}
    </div>
  );
}

function AssistantRow({
  assistant,
  group,
  active,
  needsYou,
  canAdminister,
  onRename,
  onArchive,
}: {
  assistant: AssistantSummary;
  group: AssistantGroup;
  active: boolean;
  needsYou: boolean;
  canAdminister: boolean;
  onRename: () => void;
  onArchive: () => void;
}) {
  const label = assistantLabel(assistant);
  return (
    <div
      className={cn(
        "flex items-center pr-2 text-sm transition-colors",
        active
          ? "bg-moss-wash-strong text-ink border-l-2 border-moss pl-[calc(1rem-2px)] font-medium"
          : "text-ink/85 hover:bg-ink-wash/60 pl-4 border-l-2 border-transparent",
      )}
    >
      <Tooltip content={rowTooltip(assistant, group, needsYou)} delayDuration={600}>
        <Link
          to="/chat"
          // Switching assistant clears thread and child: they are ids scoped
          // to the session you are leaving, and carrying them across would
          // point at threads that do not exist on the one you are opening.
          search={{ assistant: assistant.id, thread: undefined, child: undefined }}
          className="flex min-w-0 flex-1 items-center gap-2 py-1.5 focus-visible:bg-ink-wash focus-visible:outline-none"
        >
          {group.team ? (
            <Users className="h-3.5 w-3.5 shrink-0" aria-hidden />
          ) : (
            <Bot className="h-3.5 w-3.5 shrink-0" aria-hidden />
          )}
          <span className="flex-1 truncate">{label}</span>
          {/* The default is what every automation targets, so it is marked —
              quietly. Micro-type in the muted colour states the fact without
              competing with the row it sits on. */}
          {assistant.isDefault && (
            <span className="shrink-0 text-[10px] uppercase tracking-wide text-muted">Default</span>
          )}
          {/* A dot, not a count. Slack's grammar: a mark says something
              changed, a number says it is addressed to you — and a column of
              numbers reads as noise long before it reads as priority. The
              count belongs once, on the bell, not on every row. */}
          {needsYou && (
            <span
              className="h-1.5 w-1.5 shrink-0 rounded-full bg-warning-fg"
              aria-label="Waiting on you"
            />
          )}
        </Link>
      </Tooltip>
      {canAdminister && (
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button
              type="button"
              aria-label={`${label} actions`}
              className="ml-1 shrink-0 rounded p-0.5 text-muted transition-colors hover:bg-ink-wash hover:text-ink focus-visible:bg-ink-wash focus-visible:outline-none"
            >
              <MoreHorizontal className="h-3.5 w-3.5" aria-hidden />
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuItem onSelect={onRename}>Rename</DropdownMenuItem>
            {!assistant.isDefault && <MakeDefaultItem assistant={assistant} />}
            {assistant.isDefault ? (
              // The default cannot be archived while it is the default, so
              // the item carries the step that unblocks it rather than
              // failing on the server and saying so afterwards.
              <DropdownMenuItem disabled className="flex-col items-start gap-0">
                <span>Archive</span>
                <span className="text-[10px] text-muted">
                  Make another assistant the default first.
                </span>
              </DropdownMenuItem>
            ) : (
              <DropdownMenuItem className="text-danger-500" onSelect={onArchive}>
                Archive
              </DropdownMenuItem>
            )}
          </DropdownMenuContent>
        </DropdownMenu>
      )}
    </div>
  );
}

function MakeDefaultItem({ assistant }: { assistant: AssistantSummary }) {
  const patch = usePatchAssistant();
  return (
    <DropdownMenuItem
      disabled={patch.isPending}
      onSelect={() => patch.mutate({ id: assistant.id, body: { isDefault: true } })}
    >
      Make default
    </DropdownMenuItem>
  );
}

function rowTooltip(
  assistant: AssistantSummary,
  group: AssistantGroup,
  needsYou: boolean,
): string {
  const label = assistantLabel(assistant);
  const notes: string[] = [];
  if (group.team) {
    const count = group.team.memberCount;
    notes.push(`Shared with ${count} ${count === 1 ? "person" : "people"} on ${group.team.name}.`);
  }
  if (assistant.isDefault) notes.push("Automations use this assistant.");
  if (needsYou) notes.push("Waiting on an answer.");
  return notes.length > 0 ? `${label} — ${notes.join(" ")}` : label;
}

function RenameAssistantDialog({
  assistant,
  onClose,
}: {
  assistant: AssistantSummary;
  onClose: () => void;
}) {
  const [name, setName] = useState(assistant.name ?? "");
  const patch = usePatchAssistant();

  function submit() {
    const trimmed = name.trim();
    if (!trimmed) return;
    patch.mutate({ id: assistant.id, body: { name: trimmed } }, { onSuccess: onClose });
  }

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogContent
        title="Rename assistant"
        description="The name shows in the sidebar and above the conversation."
      >
        <Input
          value={name}
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") submit();
          }}
          placeholder="Assistant name"
          aria-label="Assistant name"
          autoFocus
        />
        {patch.error != null && <p className="text-xs text-danger-500">{errorText(patch.error)}</p>}
        <DialogFooter>
          <Button type="button" variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button type="button" onClick={submit} disabled={!name.trim() || patch.isPending}>
            {patch.isPending ? "Saving…" : "Save"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function ArchiveAssistantDialog({
  assistant,
  onClose,
  onArchived,
}: {
  assistant: AssistantSummary;
  onClose: () => void;
  onArchived: () => void;
}) {
  const archive = useArchiveAssistant();
  return (
    <ConfirmDialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
      title={`Archive ${assistantLabel(assistant)}?`}
      description="The assistant leaves the sidebar. The threads it holds are kept."
      confirmLabel="Archive assistant"
      pendingLabel="Archiving…"
      pending={archive.isPending}
      error={archive.error != null ? errorText(archive.error) : undefined}
      onConfirm={() => archive.mutate(assistant.id, { onSuccess: onArchived })}
    />
  );
}
