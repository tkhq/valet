import { useState } from "react";
import { ChevronRight, MoreHorizontal, UserPlus, X } from "lucide-react";
import type { OrgMemberWire, TeamSummary } from "@valet/api/wire";
import {
  Avatar,
  AvatarFallback,
  Badge,
  Button,
  Dialog,
  DialogContent,
  DialogFooter,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
  Input,
  Spinner,
} from "~/components/primitives";
import { ApiError } from "~/api/client";
import {
  useAddTeamMember,
  useCreateTeam,
  useDeleteTeam,
  useRemoveTeamMember,
  useSetTeamMemberRole,
  useTeamMembers,
  useTeams,
} from "~/api/settings";

function formatDate(ts: number): string {
  return new Date(ts).toLocaleDateString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}

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
 */
export function TeamsPanel({ orgMembers }: { orgMembers: OrgMemberWire[] }) {
  const teamsQ = useTeams();
  const [expanded, setExpanded] = useState<string | null>(null);

  return (
    <div className="space-y-4">
      <CreateTeamRow />

      {teamsQ.isLoading && (
        <div className="flex items-center gap-2 py-4 text-sm text-muted">
          <Spinner size={14} /> Loading…
        </div>
      )}
      {teamsQ.error && <p className="py-4 text-sm text-danger-500">Failed to load teams.</p>}

      {teamsQ.data && teamsQ.data.teams.length === 0 && (
        <p className="py-4 text-sm text-muted">No teams yet. Create one above.</p>
      )}

      {teamsQ.data && teamsQ.data.teams.length > 0 && (
        <div className="divide-y divide-line border-t border-line">
          {teamsQ.data.teams.map((team) => (
            <TeamRow
              key={team.id}
              team={team}
              orgMembers={orgMembers}
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
            setError(err.message);
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
  open,
  onToggle,
}: {
  team: TeamSummary;
  orgMembers: OrgMemberWire[];
  open: boolean;
  onToggle: () => void;
}) {
  const [confirmDelete, setConfirmDelete] = useState(false);
  const deleteTeam = useDeleteTeam();
  const managed = team.origin === "idp";

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
          <span className="shrink-0 text-xs text-muted">
            {team.memberCount} {team.memberCount === 1 ? "member" : "members"}
          </span>
        </button>
        <span className="hidden shrink-0 text-xs text-muted sm:block">
          Created {formatDate(team.createdAt)}
        </span>
        {/* Delete is the only item in this menu, and the API refuses it on a
            mirrored team. An empty menu is worse than no menu. */}
        {!managed && (
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

      {open && <TeamMembers team={team} orgMembers={orgMembers} />}

      <Dialog open={confirmDelete} onOpenChange={setConfirmDelete}>
        <DialogContent
          title={`Delete ${team.name}?`}
          description="This removes the team and its membership. Org members themselves are not affected."
        >
          <DialogFooter>
            <Button type="button" variant="secondary" onClick={() => setConfirmDelete(false)}>
              Cancel
            </Button>
            <Button
              type="button"
              variant="danger"
              disabled={deleteTeam.isPending}
              onClick={() => {
                deleteTeam.mutate(team.id, { onSuccess: () => setConfirmDelete(false) });
              }}
            >
              {deleteTeam.isPending ? "Deleting…" : "Delete team"}
            </Button>
          </DialogFooter>
          {deleteTeam.error && (
            <p className="text-xs text-danger-500">{deleteTeam.error.message}</p>
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}

function TeamMembers({ team, orgMembers }: { team: TeamSummary; orgMembers: OrgMemberWire[] }) {
  const teamId = team.id;
  const teamName = team.name;
  const managed = team.origin === "idp";
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
          reader finds the reason in the place they look for the control. */}
      {managed && <p className="pt-1 text-xs text-muted">{idpManagedNote(team.externalId)}</p>}

      {membersQ.isLoading && (
        <div className="flex items-center gap-2 py-2 text-xs text-muted">
          <Spinner size={12} /> Loading members…
        </div>
      )}
      {membersQ.error && (
        <p className="py-2 text-xs text-danger-500">Failed to load {teamName}'s members.</p>
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
            {managed ? (
              // The role follows the identity provider's sub-group, so it is
              // a fact to read here, not a control.
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

      {!managed && addable.length > 0 && (
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
