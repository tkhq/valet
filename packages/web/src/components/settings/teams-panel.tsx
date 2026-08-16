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
 * Organization · Teams — the first-ever teams management UI over the
 * existing `/api/teams` router. List with inline create, per-team expand
 * revealing the member roster + add/remove/role-toggle, and delete-via-
 * confirm. All member display data (name/email/avatar) is cross-referenced
 * against `useOrgMembers()` since `TeamMemberSummary` on the wire is only
 * `{userId, role}`.
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
        {canMutate && (
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

      {open && <TeamMembers teamId={team.id} teamName={team.name} orgMembers={orgMembers} canMutate={canMutate} />}

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
  teamId,
  teamName,
  orgMembers,
  canMutate,
}: {
  teamId: string;
  teamName: string;
  orgMembers: OrgMemberWire[];
  canMutate: boolean;
}) {
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
            {canMutate ? (
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
            ) : (
              <Badge variant={member.role === "admin" ? "accent" : "neutral"}>
                {member.role === "admin" ? "Admin" : "Member"}
              </Badge>
            )}
            {canMutate && (
              <Button
                type="button"
                variant="ghost"
                size="sm"
                aria-label={`Remove ${identity?.name ?? identity?.email ?? member.userId} from ${teamName}`}
                onClick={() => removeMember.mutate({ teamId, userId: member.userId })}
              >
                <X className="h-3.5 w-3.5" aria-hidden />
              </Button>
            )}
          </div>
        );
      })}

      {canMutate && addable.length > 0 && (
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
