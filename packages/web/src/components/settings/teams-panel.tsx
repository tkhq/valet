import { useEffect, useId, useMemo, useRef, useState } from "react";
import { Link } from "@tanstack/react-router";
import { Bot, ChevronRight, MoreHorizontal, UserPlus, X } from "lucide-react";
import type { OrgDirectoryUserWire, TeamSummary } from "@valet/api/wire";
import {
  Avatar,
  AvatarFallback,
  Badge,
  Button,
  ConfirmDialog,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
  EmptyRow,
  ErrorRow,
  Input,
  LoadingRow,
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "~/components/primitives";
import { ApiError } from "~/api/client";
import { defaultAssistantFor, useAssistants } from "~/api/assistants";
import { errorText } from "~/lib/error-text";
import { formatDate } from "~/lib/format-when";
import { matchesNeedle } from "~/lib/text-match";
import {
  useAddTeamMember,
  useCreateTeam,
  useDeleteTeam,
  useMe,
  useOrg,
  usePatchTeam,
  useRemoveTeamMember,
  useSetTeamMemberRole,
  useTeamMembers,
  useTeams,
} from "~/api/settings";
import { ModelCombobox } from "~/components/settings/model-combobox";
import { curatedForCatalogId } from "~/lib/models";

/**
 * Says why a mirrored team has no controls, in the same words the API uses
 * when it refuses the same change. A reader must not have to press a button
 * to find out that it cannot work.
 */
function idpManagedNote(externalId: string | null): string {
  const source = externalId ? `identity provider group ${externalId}` : "your identity provider";
  return `Membership comes from ${source}. Add or remove people there, then ask them to sign in again.`;
}

/**
 * Says what a team that WAS mirrored is now, while team sync is off.
 *
 * A reader who finds these controls working again needs to know two things
 * the row cannot show: nothing updates this membership any more, and turning
 * the setting back on hands the membership back to the identity provider.
 * Without the second half, an edit made here looks permanent.
 */
function idpDormantNote(externalId: string | null): string {
  const source = externalId ? `group ${externalId}` : "an identity provider group";
  return (
    `This team came from ${source}, and team sync is off, so nothing updates its membership. ` +
    `You can edit it here. If you turn team sync back on, the identity provider owns this membership again.`
  );
}

/**
 * Says what a declared team's controls do and do not survive.
 *
 * The member controls stay live here, unlike a mirrored team's, because the
 * config file only adds. The reader still needs the half that does not last:
 * a person removed here comes back at the next restart if the file still
 * declares them.
 */
const CONFIG_MANAGED_NOTE =
  "This team is declared in valet.yaml. You can change its members here, but a restart adds the " +
  "declared members back. Edit the file to change that list, or to delete the team.";

/** What a delete removes, for every team. */
const DELETE_TEAM_NOTE =
  "This deletes the team, its membership, and its skills and skill sources. If the team still owns " +
  "workflows, the delete fails — move or delete those first. Org members themselves are not affected.";

/**
 * The half a paused mirror's delete does not say on its own. The group is
 * still in the identity provider, so this delete removes the Valet side only.
 */
const DELETE_DORMANT_MIRROR_NOTE =
  "This team came from an identity provider group. If you turn team sync back on, the group creates " +
  "the team again with no skills and no skill sources.";

/**
 * Organization · Teams — the first-ever teams management UI over the
 * existing `/api/teams` router. List with inline create, per-team expand
 * revealing the member roster + add/remove/role-toggle, and delete-via-
 * confirm. All member display data (name/email/avatar) is cross-referenced
 * against the org directory (`useOrgDirectory()`, member-visible) since
 * `TeamMemberSummary` on the wire is only `{userId, role}`.
 *
 * A team with `origin === "idp"` mirrors an identity-provider group, and the
 * API refuses every mutation on it. This panel therefore renders none of
 * those controls — no delete, no role menu, no remove, no add — rather than
 * disabling them, and shows `idpManagedNote` where they would have been. A
 * disabled control the reader cannot explain is worse than no control.
 * Creating a team is untouched: every team made here is `local`.
 *
 * That holds only while the org's `ssoTeamSync` feature is ON. With it off,
 * no login sync runs, the API accepts the same four mutations again
 * (`isLiveIdpMirror`, packages/api/src/services/teams.ts), and this panel
 * returns the controls. The row keeps a badge and `idpDormantNote`, because
 * a team that silently stopped tracking its group is the one thing a reader
 * cannot work out from what is on screen.
 *
 * A team with `origin === "config"` is declared in `valet.yaml`, and it is
 * deliberately treated differently. The file only asserts members, so the
 * member controls keep working and the panel keeps them. Only delete goes,
 * because the API refuses it: the next boot would recreate the team empty.
 * `CONFIG_MANAGED_NOTE` states the half a reader cannot see — that a restart
 * puts the declared members back.
 */
export function TeamsPanel({ orgMembers }: { orgMembers: OrgDirectoryUserWire[] }) {
  const teamsQ = useTeams();
  const meQ = useMe();
  const orgQ = useOrg();
  const [expanded, setExpanded] = useState<string | null>(null);
  // Mirrors the API's canMutateTeam gate: team admin of that team, or org
  // admin. The API still enforces; this only hides controls that would 404.
  const orgAdmin = meQ.data?.orgRole === "admin";
  // Whether an `idp` team is a LIVE mirror. Off is the default, and it is
  // also what an unloaded org query reads as — which shows the controls for
  // a moment. That is the safe way round: the API refuses a mutation on a
  // live mirror anyway, so the worst case is a 409 the row reports, not a
  // change nobody expected.
  const mirroring = orgQ.data?.features.ssoTeamSync === true;

  return (
    <div className="space-y-4">
      <CreateTeamRow />

      {teamsQ.isLoading && <LoadingRow />}
      {teamsQ.error != null && <ErrorRow>Failed to load teams.</ErrorRow>}

      {teamsQ.data && teamsQ.data.teams.length === 0 && (
        <EmptyRow>No teams yet. Create one above.</EmptyRow>
      )}

      {teamsQ.data && teamsQ.data.teams.length > 0 && (
        <div className="divide-y divide-line border-t border-line">
          {teamsQ.data.teams.map((team) => (
            <TeamRow
              key={team.id}
              team={team}
              orgMembers={orgMembers}
              canMutate={orgAdmin || team.callerRole === "admin"}
              mirroring={mirroring}
              open={expanded === team.id}
              onToggle={() => setExpanded((cur) => (cur === team.id ? null : team.id))}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function CreateTeamRow() {
  const [name, setName] = useState("");
  const [error, setError] = useState<string | null>(null);
  const createTeam = useCreateTeam();

  function submit() {
    const trimmed = name.trim();
    if (!trimmed) return;
    setError(null);
    createTeam.mutate(
      { name: trimmed },
      {
        onSuccess: () => setName(""),
        onError: (err) => {
          if (err instanceof ApiError && err.status === 409) {
            setError("A team with that name already exists.");
          } else {
            setError(errorText(err));
          }
        },
      },
    );
  }

  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex gap-2">
        <Input
          value={name}
          onChange={(e) => {
            setName(e.target.value);
            if (error) setError(null);
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter") submit();
          }}
          placeholder="New team name"
          aria-label="New team name"
          className="flex-1"
        />
        <Button type="button" onClick={submit} disabled={!name.trim() || createTeam.isPending}>
          {createTeam.isPending ? "Creating…" : "Create"}
        </Button>
      </div>
      {error && <p className="text-xs text-danger-500">{error}</p>}
    </div>
  );
}

function TeamRow({
  team,
  orgMembers,
  canMutate,
  mirroring,
  open,
  onToggle,
}: {
  team: TeamSummary;
  orgMembers: OrgDirectoryUserWire[];
  canMutate: boolean;
  mirroring: boolean;
  open: boolean;
  onToggle: () => void;
}) {
  const [confirmDelete, setConfirmDelete] = useState(false);
  const deleteTeam = useDeleteTeam();
  const assistantsQ = useAssistants();
  const assistant = defaultAssistantFor(assistantsQ.data?.assistants, "team", team.id);
  // `managed` is a LIVE mirror, which is the only state that hides controls.
  // `dormant` is the same row with team sync off: it explains itself, but it
  // keeps every control.
  const managed = team.origin === "idp" && mirroring;
  const dormant = team.origin === "idp" && !mirroring;
  const declared = team.origin === "config";

  // A dormant mirror gets one extra sentence. Its group still exists in the
  // identity provider, so this delete is not final in the way the reader
  // expects: turning team sync back on builds the team again, empty, and the
  // skills and skill sources deleted here do not come back with it.
  const deleteDescription = dormant
    ? `${DELETE_TEAM_NOTE} ${DELETE_DORMANT_MIRROR_NOTE}`
    : DELETE_TEAM_NOTE;

  return (
    <div className="py-3">
      <div className="flex items-center gap-3">
        <button
          type="button"
          onClick={onToggle}
          aria-label={open ? `Collapse ${team.name}` : `Expand ${team.name}`}
          aria-expanded={open}
          className="flex min-w-0 flex-1 items-center gap-2 text-left"
        >
          <ChevronRight
            className={`h-4 w-4 shrink-0 text-muted transition-transform ${open ? "rotate-90" : ""}`}
            aria-hidden
          />
          <span className="truncate text-sm font-medium text-ink">{team.name}</span>
          {managed && (
            // `title` carries the reason to a reader who never expands the
            // row. The expanded body states it in full, so this is a second
            // channel, not the only one.
            <Badge variant="accent" className="shrink-0" title={idpManagedNote(team.externalId)}>
              Identity provider
            </Badge>
          )}
          {dormant && (
            // `neutral`, like the declared team's: the controls work, so it
            // must not read as locked. The word "paused" is what separates
            // it from a team that never came from a group at all.
            <Badge variant="neutral" className="shrink-0" title={idpDormantNote(team.externalId)}>
              Identity provider (paused)
            </Badge>
          )}
          {declared && (
            // `neutral`, not the mirrored team's `accent`: this team's
            // controls still work, so it must not read as equally locked.
            <Badge variant="neutral" className="shrink-0" title={CONFIG_MANAGED_NOTE}>
              Declared in valet.yaml
            </Badge>
          )}
          <span className="shrink-0 text-xs text-muted">
            {team.memberCount} {team.memberCount === 1 ? "member" : "members"}
          </span>
        </button>
        <span className="hidden shrink-0 text-xs text-muted sm:block">
          Created {formatDate(team.createdAt)}
        </span>
        {/* A cross-link to the working surface, not a second door: `/chat`
            owns the get-or-create, so this creates nothing and needs no
            pending or error state of its own. It opens the team's DEFAULT
            assistant; the rail is where the others are chosen. */}
        {assistant && (
          <Button asChild variant="ghost" size="sm" className="shrink-0 gap-1.5">
            <Link to="/chat" search={{ assistant: assistant.id }}>
              <Bot className="h-3.5 w-3.5" aria-hidden />
              Assistant
            </Link>
          </Button>
        )}
        {/* Two gates, both required. `canMutate` is authorization; origin is
            provenance — the API refuses a delete on a mirrored team and on a
            declared one, because the next boot would recreate a declared team
            empty. Delete is the only item here, and an empty menu is worse
            than no menu. */}
        {canMutate && !managed && !declared && (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                aria-label={`${team.name} actions`}
              >
                <MoreHorizontal className="h-4 w-4" aria-hidden />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem
                className="text-danger-500"
                onSelect={() => setConfirmDelete(true)}
              >
                Delete team
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        )}
      </div>

      {open && (
        <>
          <TeamDefaultModel team={team} canMutate={canMutate} />
          <TeamMembers
            team={team}
            orgMembers={orgMembers}
            canMutate={canMutate}
            mirroring={mirroring}
          />
        </>
      )}

      <ConfirmDialog
        open={confirmDelete}
        onOpenChange={setConfirmDelete}
        title={`Delete ${team.name}?`}
        description={deleteDescription}
        confirmLabel="Delete team"
        pendingLabel="Deleting…"
        pending={deleteTeam.isPending}
        error={deleteTeam.error != null ? errorText(deleteTeam.error) : undefined}
        onConfirm={() => deleteTeam.mutate(team.id, { onSuccess: () => setConfirmDelete(false) })}
      />
    </div>
  );
}

/**
 * The team default model (TKAI-255). Sessions this team owns start on it
 * unless the member set a personal default; null falls through to the org
 * preference list. Editable by whoever can mutate the team (team admin or
 * org admin) — same gate as the roster controls, and the API enforces it.
 * NOT origin-gated: a mirrored team's membership belongs to the identity
 * provider, but its default model is Valet-local state no sync rewrites.
 */
function TeamDefaultModel({ team, canMutate }: { team: TeamSummary; canMutate: boolean }) {
  const patchTeam = usePatchTeam();

  return (
    <div className="ml-6 mt-2 border-l border-line pl-4">
      <div className="flex flex-col gap-1 py-1 sm:flex-row sm:items-center sm:gap-3">
        <span className="shrink-0 text-xs font-medium text-muted">Default model</span>
        {canMutate ? (
          <div className="w-full max-w-xs">
            <ModelCombobox
              value={team.defaultModel}
              onSelect={(id) => patchTeam.mutate({ id: team.id, body: { defaultModel: id } })}
              onClear={() => patchTeam.mutate({ id: team.id, body: { defaultModel: null } })}
            />
          </div>
        ) : (
          <span className="text-sm text-ink">
            {curatedForCatalogId(team.defaultModel)?.label ?? team.defaultModel ?? "Organization default"}
          </span>
        )}
      </div>
      {canMutate && (
        <p className="text-xs text-muted">
          Sessions in this team's workspace start on this model. A member's personal default
          still wins for that member.
        </p>
      )}
      {patchTeam.error != null && (
        <p className="text-xs text-danger-500">{errorText(patchTeam.error)}</p>
      )}
    </div>
  );
}

function TeamMembers({
  team,
  orgMembers,
  canMutate,
  mirroring,
}: {
  team: TeamSummary;
  orgMembers: OrgDirectoryUserWire[];
  canMutate: boolean;
  mirroring: boolean;
}) {
  const teamId = team.id;
  const teamName = team.name;
  const managed = team.origin === "idp" && mirroring;
  const dormant = team.origin === "idp" && !mirroring;
  const declared = team.origin === "config";
  const membersQ = useTeamMembers(teamId);
  const setRole = useSetTeamMemberRole();
  const removeMember = useRemoveTeamMember();
  const addMember = useAddTeamMember();

  const byId = new Map(orgMembers.map((m) => [m.userId, m]));
  const memberRows = membersQ.data?.members ?? [];
  const memberIds = new Set(memberRows.map((m) => m.userId));
  const addable = orgMembers.filter((m) => !memberIds.has(m.userId));

  return (
    <div className="ml-6 mt-2 space-y-2 border-l border-line pl-4">
      {/* Sits above the roster, where the add/remove controls would be, so a
          reader finds the reason in the place they look for the control. The
          declared note sits in the same place although its controls stay:
          they work, and what the reader needs is how long the change lasts. */}
      {managed && <p className="pt-1 text-xs text-muted">{idpManagedNote(team.externalId)}</p>}
      {dormant && <p className="pt-1 text-xs text-muted">{idpDormantNote(team.externalId)}</p>}
      {declared && <p className="pt-1 text-xs text-muted">{CONFIG_MANAGED_NOTE}</p>}

      {membersQ.isLoading && <LoadingRow label="Loading members…" className="py-2 text-xs" />}
      {membersQ.error != null && (
        <ErrorRow className="py-2 text-xs">Failed to load {teamName}'s members.</ErrorRow>
      )}

      {memberRows.map((member) => {
        const identity = byId.get(member.userId);
        return (
          <div key={member.userId} className="flex items-center gap-2 py-1">
            <Avatar size="sm">
              <AvatarFallback>
                {(identity?.name ?? identity?.email ?? member.userId).slice(0, 1).toUpperCase()}
              </AvatarFallback>
            </Avatar>
            <span className="min-w-0 flex-1 truncate text-sm text-ink">
              {identity?.name ?? identity?.email ?? member.userId}
            </span>
            {managed || !canMutate ? (
              // Read-only in two cases. Managed: the role follows the
              // identity provider's sub-group, so it is a fact to read here,
              // not a control. Without mutate rights: the API would 404 the
              // change anyway.
              <Badge variant={member.role === "admin" ? "accent" : "neutral"}>
                {member.role === "admin" ? "Admin" : "Member"}
              </Badge>
            ) : (
              <>
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <Button type="button" variant="secondary" size="sm">
                      <Badge variant={member.role === "admin" ? "accent" : "neutral"} className="pointer-events-none">
                        {member.role === "admin" ? "Admin" : "Member"}
                      </Badge>
                    </Button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end">
                    <DropdownMenuItem
                      onSelect={() =>
                        setRole.mutate({ teamId, userId: member.userId, body: { role: "admin" } })
                      }
                    >
                      Admin
                    </DropdownMenuItem>
                    <DropdownMenuItem
                      onSelect={() =>
                        setRole.mutate({ teamId, userId: member.userId, body: { role: "member" } })
                      }
                    >
                      Member
                    </DropdownMenuItem>
                  </DropdownMenuContent>
                </DropdownMenu>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  aria-label={`Remove ${identity?.name ?? identity?.email ?? member.userId} from ${teamName}`}
                  onClick={() => removeMember.mutate({ teamId, userId: member.userId })}
                >
                  <X className="h-3.5 w-3.5" aria-hidden />
                </Button>
              </>
            )}
          </div>
        );
      })}

      {canMutate && !managed && (
        <>
          <AddMemberPicker
            teamName={teamName}
            addable={addable}
            pending={addMember.isPending}
            onAdd={(userId) => addMember.mutate({ teamId, body: { userId, role: "member" } })}
          />
          {addMember.error != null && (
            <ErrorRow className="py-1 text-xs">
              Failed to add the member: {errorText(addMember.error)}
            </ErrorRow>
          )}
        </>
      )}
    </div>
  );
}

/** DOM cap for the picker list. The height cap alone fixes the clipping, not
 * the cost of mounting a row per org member; past this a footer row says to
 * type more. */
const ADD_MEMBER_VISIBLE_LIMIT = 50;

/**
 * "Add member" — a popover typeahead over the addable org members. The
 * previous control was a plain dropdown menu with no filter and no height
 * cap, so on a real org it ran past the bottom of the screen.
 *
 * Keyboard and ARIA mechanics follow `ServiceActionCombobox`: one highlighted
 * row that arrow keys and hover both move, Enter adds it, and
 * `aria-activedescendant` announces it. That combobox and `ModelCombobox`
 * keep their own copies of these mechanics; folding the three into one
 * primitive is deliberately out of scope here — their commit semantics
 * differ (free-text commit, clear-to-default, strict pick).
 *
 * When nobody is addable the trigger stays mounted but inert (`aria-disabled`
 * plus a title that says why). Unmounting it would drop keyboard focus to the
 * body at the exact moment the last member is added, because Radix returns
 * focus to this trigger on close.
 */
function AddMemberPicker({
  teamName,
  addable,
  pending,
  onAdd,
}: {
  teamName: string;
  addable: OrgDirectoryUserWire[];
  pending: boolean;
  onAdd: (userId: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [highlighted, setHighlighted] = useState(0);
  const listRef = useRef<HTMLDivElement>(null);
  const listboxId = useId();

  const matches = useMemo(() => {
    const filtered = addable.filter((m) => matchesNeedle(query, [m.name, m.email]));
    const needle = query.trim().toLowerCase();
    if (!needle) return filtered;
    // Prefix matches outrank substring matches: typing "dana" must put
    // "Dana A" above "adana@…", or Enter adds the wrong person.
    const rank = (m: OrgDirectoryUserWire) =>
      m.name.toLowerCase().startsWith(needle) || m.email.toLowerCase().startsWith(needle) ? 0 : 1;
    return filtered.sort((a, b) => rank(a) - rank(b));
  }, [addable, query]);

  const visible = matches.slice(0, ADD_MEMBER_VISIBLE_LIMIT);
  const hidden = matches.length - visible.length;
  // Clamp instead of trusting state: a background refetch can shrink the
  // list under a highlight that pointed past its new end.
  const active = Math.min(highlighted, Math.max(visible.length - 1, 0));
  const optionId = (i: number) => `${listboxId}-opt-${i}`;
  const inert = addable.length === 0 || pending;

  useEffect(() => {
    if (!open) return;
    const el = listRef.current?.children[active];
    if (el instanceof HTMLElement && typeof el.scrollIntoView === "function") {
      el.scrollIntoView({ block: "nearest" });
    }
  }, [active, open]);

  function add(userId: string) {
    if (pending) return;
    onAdd(userId);
    setOpen(false);
  }

  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        if (next && inert) return;
        setOpen(next);
        // A reopened picker starts from the full list, not last time's filter.
        if (next) {
          setQuery("");
          setHighlighted(0);
        }
      }}
    >
      <PopoverTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className={`gap-1.5 ${inert ? "text-muted" : ""}`}
          aria-disabled={inert || undefined}
          title={
            addable.length === 0
              ? `Everyone in the organization is already on ${teamName}.`
              : undefined
          }
        >
          <UserPlus className="h-3.5 w-3.5" aria-hidden />
          Add member
        </Button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-72 p-0">
        <div className="border-b border-line p-2">
          <Input
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              setHighlighted(0);
            }}
            onKeyDown={(e) => {
              // Enter that commits an IME composition is not a selection.
              if (e.nativeEvent.isComposing) return;
              if (visible.length === 0) return;
              if (e.key === "ArrowDown") {
                e.preventDefault();
                setHighlighted(Math.min(active + 1, visible.length - 1));
              } else if (e.key === "ArrowUp") {
                e.preventDefault();
                setHighlighted(Math.max(active - 1, 0));
              } else if (e.key === "Enter") {
                const target = visible[active];
                if (target) add(target.userId);
              }
            }}
            placeholder="Search members…"
            aria-label={`Search members to add to ${teamName}`}
            role="combobox"
            aria-expanded={open}
            aria-controls={listboxId}
            aria-activedescendant={visible.length > 0 ? optionId(active) : undefined}
            aria-autocomplete="list"
            autoComplete="off"
          />
        </div>
        <div
          ref={listRef}
          id={listboxId}
          role="listbox"
          aria-label={`Members to add to ${teamName}`}
          className="max-h-64 overflow-y-auto py-1"
        >
          {visible.map((m, i) => (
            <button
              key={m.userId}
              id={optionId(i)}
              type="button"
              role="option"
              aria-selected={i === active}
              onClick={() => add(m.userId)}
              onMouseEnter={() => setHighlighted(i)}
              className={`flex w-full items-center gap-2 px-3 py-1.5 text-left text-sm ${
                i === active ? "bg-ink-wash" : ""
              }`}
            >
              <span className="min-w-0 flex-1 truncate text-ink">{m.name || m.email}</span>
              {m.name ? <span className="shrink-0 text-xs text-muted">{m.email}</span> : null}
            </button>
          ))}
          {hidden > 0 && (
            <div className="border-t border-line px-3 py-1.5 text-xs text-muted">
              {hidden} more {hidden === 1 ? "match" : "matches"}. Type more letters to narrow the
              list.
            </div>
          )}
          {visible.length === 0 && (
            <div className="px-3 py-1.5 text-sm text-muted">No matching members.</div>
          )}
        </div>
      </PopoverContent>
    </Popover>
  );
}
