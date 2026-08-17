import { useState } from "react";
import { Link } from "@tanstack/react-router";
import { Bot, ChevronRight, MoreHorizontal, UserPlus, X } from "lucide-react";
import type { OrgMemberWire, TeamSummary } from "@valet/api/wire";
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
} from "~/components/primitives";
import { ApiError } from "~/api/client";
import { defaultAssistantFor, useAssistants } from "~/api/assistants";
import { errorText } from "~/lib/error-text";
import { formatDate } from "~/lib/format-when";
import {
  useAddTeamMember,
  useCreateTeam,
  useDeleteTeam,
  useMe,
  useRemoveTeamMember,
  useSetTeamMemberRole,
  useTeamMembers,
  useTeams,
} from "~/api/settings";

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

/**
 * Organization · Teams — the first-ever teams management UI over the
 * existing `/api/teams` router. List with inline create, per-team expand
 * revealing the member roster + add/remove/role-toggle, and delete-via-
 * confirm. All member display data (name/email/avatar) is cross-referenced
 * against `useOrgMembers()` since `TeamMemberSummary` on the wire is only
 * `{userId, role}`.
 *
 * A team with `origin === "idp"` mirrors an identity-provider group, and the
 * API refuses every mutation on it. This panel therefore renders none of
 * those controls — no delete, no role menu, no remove, no add — rather than
 * disabling them, and shows `idpManagedNote` where they would have been. A
 * disabled control the reader cannot explain is worse than no control.
 * Creating a team is untouched: every team made here is `local`.
 *
 * A team with `origin === "config"` is declared in `valet.yaml`, and it is
 * deliberately treated differently. The file only asserts members, so the
 * member controls keep working and the panel keeps them. Only delete goes,
 * because the API refuses it: the next boot would recreate the team empty.
 * `CONFIG_MANAGED_NOTE` states the half a reader cannot see — that a restart
 * puts the declared members back.
 */
export function TeamsPanel({ orgMembers }: { orgMembers: OrgMemberWire[] }) {
  const teamsQ = useTeams();
  const meQ = useMe();
  const [expanded, setExpanded] = useState<string | null>(null);
  // Mirrors the API's canMutateTeam gate: team admin of that team, or org
  // admin. The API still enforces; this only hides controls that would 404.
  const orgAdmin = meQ.data?.orgRole === "admin";

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
  open,
  onToggle,
}: {
  team: TeamSummary;
  orgMembers: OrgMemberWire[];
  canMutate: boolean;
  open: boolean;
  onToggle: () => void;
}) {
  const [confirmDelete, setConfirmDelete] = useState(false);
  const deleteTeam = useDeleteTeam();
  const assistantsQ = useAssistants();
  const assistant = defaultAssistantFor(assistantsQ.data?.assistants, "team", team.id);
  const managed = team.origin === "idp";
  const declared = team.origin === "config";

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

      {open && <TeamMembers team={team} orgMembers={orgMembers} canMutate={canMutate} />}

      <ConfirmDialog
        open={confirmDelete}
        onOpenChange={setConfirmDelete}
        title={`Delete ${team.name}?`}
        description="This deletes the team, its membership, and its skills and skill sources. If the team still owns workflows, the delete fails — move or delete those first. Org members themselves are not affected."
        confirmLabel="Delete team"
        pendingLabel="Deleting…"
        pending={deleteTeam.isPending}
        error={deleteTeam.error != null ? errorText(deleteTeam.error) : undefined}
        onConfirm={() => deleteTeam.mutate(team.id, { onSuccess: () => setConfirmDelete(false) })}
      />
    </div>
  );
}

function TeamMembers({
  team,
  orgMembers,
  canMutate,
}: {
  team: TeamSummary;
  orgMembers: OrgMemberWire[];
  canMutate: boolean;
}) {
  const teamId = team.id;
  const teamName = team.name;
  const managed = team.origin === "idp";
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

      {canMutate && !managed && addable.length > 0 && (
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button type="button" variant="ghost" size="sm" className="gap-1.5">
              <UserPlus className="h-3.5 w-3.5" aria-hidden />
              Add member
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start">
            {addable.map((m) => (
              <DropdownMenuItem
                key={m.userId}
                onSelect={() =>
                  addMember.mutate({ teamId, body: { userId: m.userId, role: "member" } })
                }
              >
                {m.name ?? m.email}
              </DropdownMenuItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
      )}
    </div>
  );
}
