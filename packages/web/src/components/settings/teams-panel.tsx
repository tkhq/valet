import { LineEditor } from "~/components/presence/editor/line-editor";
import { Link, useNavigate } from "@tanstack/react-router";
import type { OrgDirectoryUserWire, TeamSummary } from "@valet/api/wire";
import { ChevronRight, MoreHorizontal, UserPlus, X } from "lucide-react";
import { useEffect, useId, useMemo, useRef, useState } from "react";
import { ApiError } from "~/api/client";
import {
  useAddTeamMember,
  useCreateTeam,
  useDeleteTeam,
  useMe,
  useModelTiers,
  useModels,
  usePatchTeam,
  useRemoveTeamMember,
  useSetTeamMemberRole,
  useTeamMembers,
  useTeams,
} from "~/api/settings";
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
  SelectMenu,
  textLinkClass,
} from "~/components/primitives";
import { FieldRow } from "~/components/settings/field-row";
import { ModelCombobox } from "~/components/settings/model-combobox";
import { ReasoningSelect } from "~/components/settings/reasoning-select";
import { Section } from "~/components/settings/section";
import { errorText } from "~/lib/error-text";
import { formatDate } from "~/lib/format-when";
import { fallbackLabel, isSizeTier, TIER_LABELS } from "~/lib/model-tiers";
import { curatedForCatalogId } from "~/lib/models";
import { reasoningLabelFor } from "~/lib/reasoning";
import { matchesNeedle } from "~/lib/text-match";
import { TeamDeletionRequests } from "./team-deletion-requests";

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
  "This deletes the team, its membership, its skills and skill sources, and its workflows. " +
  "If a team workflow is still running, the delete fails — wait for it to finish, or cancel it, then try again. " +
  "Org members themselves are not affected.";

/**
 * Teams over the `/api/teams` router, in two places.
 *
 * - **Organization · Teams** (no `teamId`): create a team, then one row per
 *   team. A row is a link to that team's settings page, and an admin of the
 *   team can delete it from the row's menu. The team is edited on its page,
 *   never in the list.
 * - **A team's General tab** (`teamId`): the team's name, members, defaults,
 *   Slack home channel, and deletion requests, each a `Section`.
 *
 * All member display data (name/email/avatar) is cross-referenced against
 * the org directory (`useOrgDirectory()`, member-visible) since
 * `TeamMemberSummary` on the wire is only `{userId, role}`.
 *
 * A team with `origin === "idp"` keeps its provenance badge, but its
 * membership is managed here. Login only refreshes join eligibility and
 * never changes a team or membership.
 *
 * A team with `origin === "config"` is declared in `valet.yaml`, and it is
 * deliberately treated differently. The file only asserts members, so the
 * member controls keep working. Only delete goes, because the API refuses
 * it: the next boot would recreate the team empty. `CONFIG_MANAGED_NOTE`
 * states the half a reader cannot see: a restart puts the declared
 * members back.
 */
export function TeamsPanel({
  orgMembers,
  teamId,
}: {
  orgMembers: OrgDirectoryUserWire[];
  /** The team whose General tab this is. Without it, the organization list. */
  teamId?: string;
}) {
  const teamsQ = useTeams();
  const meQ = useMe();
  // Mirrors the API's canMutateTeam gate: team admin of that team, or org
  // admin. The API still enforces; this only hides controls that would 404.
  const orgAdmin = meQ.data?.orgRole === "admin";
  const teams = teamsQ.data?.teams.filter((team) => teamId === undefined || team.id === teamId) ?? [];
  const ready = !teamsQ.isLoading && teamsQ.error == null;

  return (
    <div className="space-y-4">
      {teamId === undefined && <CreateTeamRow />}

      {teamsQ.isLoading && <LoadingRow />}
      {teamsQ.error != null && <ErrorRow>Failed to load teams. Reload the page to try again.</ErrorRow>}

      {ready && teamsQ.data && teams.length === 0 && (
        <EmptyRow>
          {teamId === undefined
            ? "No teams yet. Create one above."
            : "You are not a member of this team. Choose a team under Your teams."}
        </EmptyRow>
      )}

      {ready && teamId === undefined && teams.length > 0 && (
        <ul className="divide-y divide-line border-t border-line">
          {teams.map((team) => (
            <TeamListRow key={team.id} team={team} canMutate={orgAdmin || team.callerRole === "admin"} />
          ))}
        </ul>
      )}

      {ready && teamId !== undefined && teams[0] && (
        <TeamGeneral key={teams[0].id} team={teams[0]} orgMembers={orgMembers} canMutate={orgAdmin || teams[0].callerRole === "admin"} />
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

/** The team's provenance badges. `neutral` for a declared team, not the
 * mirrored team's `accent`: its controls still work, so it must not read as
 * equally locked. */
function TeamBadges({ team }: { team: TeamSummary }) {
  return (
    <>
      {team.origin === "idp" && <Badge variant="neutral" className="shrink-0">Identity provider</Badge>}
      {team.origin === "config" && (
        <Badge variant="neutral" className="shrink-0" title={CONFIG_MANAGED_NOTE}>Declared in valet.yaml</Badge>
      )}
    </>
  );
}

/** One row of the organization list: a link to the team's settings page,
 * and Delete for whoever administers the team. */
function TeamListRow({ team, canMutate }: { team: TeamSummary; canMutate: boolean }) {
  return (
    <li className="flex flex-wrap items-center gap-3 py-3">
      <Link
        to="/settings/teams/$teamId"
        params={{ teamId: team.id }}
        className="flex min-h-11 min-w-0 flex-1 flex-wrap items-center gap-2 rounded-md hover:text-ink sm:min-h-0"
      >
        <span className="truncate text-sm font-medium text-ink">{team.name}</span>
        <TeamBadges team={team} />
        <span className="shrink-0 text-xs text-muted">
          {team.memberCount} {team.memberCount === 1 ? "member" : "members"}
        </span>
        <span className="hidden shrink-0 text-xs text-muted sm:inline">Created {formatDate(team.createdAt)}</span>
        <ChevronRight className="ml-auto h-4 w-4 shrink-0 text-muted" aria-hidden />
      </Link>
      {/* A member's deletion request needs the team's page, where its form lives. */}
      {canMutate && <TeamActions team={team} canMutate />}
    </li>
  );
}

/**
 * The team's actions menu: Delete for whoever administers the team, else
 * Request deletion. Two gates, both required. `canMutate` is authorization;
 * origin is provenance: the API refuses a delete on a declared team,
 * because the next boot would recreate it empty. Delete is the only item
 * there, and an empty menu is worse than no menu.
 */
function TeamActions({ team, canMutate, onDeleted, onRequestDeletion }: {
  team: TeamSummary;
  canMutate: boolean;
  onDeleted?: () => void;
  /** Opens the request form. Only the team's page has one. */
  onRequestDeletion?: () => void;
}) {
  const [confirmDelete, setConfirmDelete] = useState(false);
  const deleteTeam = useDeleteTeam();
  if (team.origin === "config") return null;
  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button type="button" variant="ghost" size="sm" aria-label={`${team.name} actions`}>
            <MoreHorizontal className="h-4 w-4" aria-hidden />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          <DropdownMenuItem
            className="text-danger-500"
            onSelect={() => {
              // React Query holds `error` until the next mutate, so
              // without this the last refusal greets the next open.
              if (canMutate) {
                deleteTeam.reset();
                setConfirmDelete(true);
              } else {
                onRequestDeletion?.();
              }
            }}
          >
            {canMutate ? "Delete team" : "Request deletion"}
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      <ConfirmDialog
        open={confirmDelete}
        onOpenChange={setConfirmDelete}
        title={`Delete ${team.name}?`}
        description={DELETE_TEAM_NOTE}
        confirmLabel="Delete team"
        pendingLabel="Deleting…"
        pending={deleteTeam.isPending}
        error={deleteTeam.error != null ? errorText(deleteTeam.error) : undefined}
        onConfirm={() => deleteTeam.mutate(team.id, {
          onSuccess: () => {
            setConfirmDelete(false);
            onDeleted?.();
          },
        })}
      />
    </>
  );
}

/** A team's General tab: one `Section` per part, the same card anatomy as
 * every other settings page. Connections are on the Integrations tab. */
function TeamGeneral({ team, orgMembers, canMutate }: {
  team: TeamSummary;
  orgMembers: OrgDirectoryUserWire[];
  canMutate: boolean;
}) {
  const [deletionRequest, setDeletionRequest] = useState<string | null>(null);
  const navigate = useNavigate();
  // A team the caller deleted or left would read as "not a member" here.
  // Profile is the settings landing page. Replace, so Back does not return
  // to the gone team.
  const leavePage = () => void navigate({ to: "/settings/profile", replace: true });

  return (
    <div className="space-y-10">
      <div className="flex flex-wrap items-center gap-2">
        <TeamBadges team={team} />
        <span className="text-xs text-muted">Created {formatDate(team.createdAt)}</span>
        <div className="ml-auto">
          <TeamActions team={team} canMutate={canMutate} onDeleted={leavePage} onRequestDeletion={() => setDeletionRequest(`team:${team.id}`)} />
        </div>
      </div>
      {canMutate && team.origin !== "config" && <TeamName team={team} />}
      <TeamMembers team={team} orgMembers={orgMembers} canMutate={canMutate} onSelfRemoved={leavePage} />
      <TeamDefaults team={team} canMutate={canMutate} />
      <TeamSlack team={team} canMutate={canMutate} />
      <TeamDeletionRequests
        teamId={team.id}
        canManage={canMutate}
        request={deletionRequest}
        onRequestChange={setDeletionRequest}
      />
    </div>
  );
}

/**
 * The team default model and reasoning level (TKAI-255; reasoning added
 * Task 15). Member-started sessions in this team's workspace start on
 * these unless that member set a personal default; shared team sessions
 * (assistant, workflow runs, children) skip the personal tier and start on
 * them directly. A session's model/reasoning persists, so the setting only
 * shapes sessions built after the change. Null falls through to the
 * cascade's next tier / org default reasoning. Editable by whoever can mutate
 * the team (team admin or org admin) — same gate as the roster controls,
 * and the API enforces it. NOT origin-gated: a mirrored team's membership
 * belongs to the identity provider, but its defaults are Valet-local state
 * no sync rewrites.
 */
function TeamDefaults({
  team,
  canMutate,
}: {
  team: TeamSummary;
  canMutate: boolean;
}) {
  const patchTeam = usePatchTeam();
  // Same label chain as ModelCombobox (tier label, then curated label, then
  // catalog name, then raw id) so members and admins read the same words
  // for one value.
  const modelsQ = useModels();
  const tiersQ = useModelTiers();
  // Unset falls to the org default tier, so the label names that tier.
  const modelFallbackLabel = fallbackLabel("Organization default", tiersQ.data);
  const entry = modelsQ.data?.models.find((m) => m.id === team.defaultModel);
  const readOnlyModelLabel = team.defaultModel
    ? isSizeTier(team.defaultModel)
      ? TIER_LABELS[team.defaultModel]
      : (curatedForCatalogId(team.defaultModel)?.label ?? entry?.name ?? team.defaultModel)
    : modelFallbackLabel;
  const readOnlyReasoningLabel = team.defaultReasoning
    ? reasoningLabelFor(team.defaultReasoning)
    : "Organization default";

  return (
    <Section
      title="Defaults"
      description="New runtimes in this team's workspace use these, unless the member who starts one has a personal default."
    >
        <FieldRow label="Model">
          {canMutate ? (
            <ModelCombobox
              value={team.defaultModel}
              onSelect={(id) => patchTeam.mutate({ id: team.id, body: { defaultModel: id } })}
              onClear={() => patchTeam.mutate({ id: team.id, body: { defaultModel: null } })}
              emptyLabel={modelFallbackLabel}
            />
          ) : (
            <p className="truncate text-sm text-ink sm:pt-2" title={team.defaultModel ?? undefined}>
              {readOnlyModelLabel}
            </p>
          )}
        </FieldRow>
        <FieldRow label="Reasoning">
          {canMutate ? (
            <ReasoningSelect
              value={team.defaultReasoning ?? null}
              onChange={(defaultReasoning) => patchTeam.mutate({ id: team.id, body: { defaultReasoning } })}
              emptyLabel="Organization default"
            />
          ) : (
            <p className="truncate text-sm text-ink sm:pt-2" title={team.defaultReasoning ?? undefined}>
              {readOnlyReasoningLabel}
            </p>
          )}
        </FieldRow>
      {patchTeam.error != null && <ErrorRow className="py-3 text-xs">{errorText(patchTeam.error)}</ErrorRow>}
    </Section>
  );
}

function TeamMembers({
  team,
  orgMembers,
  canMutate,
  onSelfRemoved,
}: {
  team: TeamSummary;
  orgMembers: OrgDirectoryUserWire[];
  canMutate: boolean;
  /** Runs once the caller removes their own membership. */
  onSelfRemoved?: () => void;
}) {
  const meQ = useMe();
  const teamId = team.id;
  const teamName = team.name;
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
    <Section
      title="Members"
      description={declared ? CONFIG_MANAGED_NOTE : undefined}
      actions={
        canMutate && (
          <AddMemberPicker
            teamName={teamName}
            addable={addable}
            pending={addMember.isPending}
            onAdd={(userId) => addMember.mutate({ teamId, body: { userId, role: "member" } })}
          />
        )
      }
    >
      {membersQ.isLoading && <LoadingRow label="Loading members…" className="py-2 text-xs" />}
      {membersQ.error != null && (
        <ErrorRow className="py-2 text-xs">Failed to load {teamName}'s members.</ErrorRow>
      )}

      {memberRows.length > 0 && <ul>
        {memberRows.map((member) => {
          const identity = byId.get(member.userId);
          const name = identity?.name ?? identity?.email ?? member.userId;
          return (
            <li key={member.userId} className="flex items-center gap-3 py-1.5">
              <Avatar size="sm">
                <AvatarFallback>{name.slice(0, 1).toUpperCase()}</AvatarFallback>
              </Avatar>
              <span className="min-w-0 flex-1 truncate text-sm text-ink">{name}</span>
              {canMutate ? (
                <>
                  <SelectMenu
                    value={member.role}
                    options={ROLE_OPTIONS}
                    align="end"
                    onChange={(role) => {
                      if (role !== member.role) setRole.mutate({ teamId, userId: member.userId, body: { role } });
                    }}
                  />
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    aria-label={`Remove ${name} from ${teamName}`}
                    onClick={() => removeMember.mutate(
                      { teamId, userId: member.userId },
                      { onSuccess: () => { if (member.userId === meQ.data?.id) onSelfRemoved?.(); } },
                    )}
                  >
                    <X className="h-3.5 w-3.5" aria-hidden />
                  </Button>
                </>
              ) : (
                <Badge variant={member.role === "admin" ? "accent" : "neutral"}>
                  {member.role === "admin" ? "Admin" : "Member"}
                </Badge>
              )}
            </li>
          );
        })}
      </ul>}

      {addMember.error != null && (
        <ErrorRow className="py-3 text-xs">Failed to add the member: {errorText(addMember.error)}</ErrorRow>
      )}
    </Section>
  );
}

const ROLE_OPTIONS = [
  { value: "admin", label: "Admin" },
  { value: "member", label: "Member" },
] as const;

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
          variant="secondary"
          size="sm"
          className={inert ? "text-muted" : undefined}
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
      <PopoverContent align="end" className="w-72 max-w-[calc(100vw-2rem)] p-0">
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
              className={`flex min-h-11 w-full flex-col items-start gap-1 px-3 py-1.5 text-left text-sm sm:min-h-0 ${
                i === active ? "bg-ink-wash" : ""
              }`}
            >
              <span className="max-w-full break-words text-ink">{m.name || m.email}</span>
              {m.name ? <span className="max-w-full break-all text-xs text-muted">{m.email}</span> : null}
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

/** Rename. Hidden for a team declared in the config file, which the API
 * refuses: the config reconciler matches a declared team by name. */
function TeamName({ team }: { team: TeamSummary }) {
  const [name, setName] = useState(team.name);
  const patch = usePatchTeam();
  useEffect(() => setName(team.name), [team.name]);
  const next = name.trim();
  return (
    <Section title="Name">
      <FieldRow label="Team name" error={patch.error ? errorText(patch.error) : undefined}>
        <div className="flex gap-2">
          <Input aria-label="Team name" value={name} onChange={(event) => setName(event.target.value)} />
          <Button
            disabled={patch.isPending || next === "" || next === team.name}
            onClick={() => patch.mutate({ id: team.id, body: { name: next } })}
          >
            Save
          </Button>
        </div>
      </FieldRow>
    </Section>
  );
}

function TeamSlack({ team, canMutate }: { team: TeamSummary; canMutate: boolean }) {
  const [channel, setChannel] = useState(team.slackHomeChannelId ?? "");
  const [replySetup, setReplySetup] = useState(false);
  const patch = usePatchTeam();
  useEffect(() => setChannel(team.slackHomeChannelId ?? ""), [team.slackHomeChannelId]);
  return (
    <Section
      title="Slack"
      description="Valet posts new team notifications in the home channel. Add the Valet bot to that channel first."
      actions={<Button variant="secondary" size="sm" onClick={() => setReplySetup(true)}>Set up Slack replies</Button>}
    >
      <FieldRow label="Home channel" error={patch.error ? errorText(patch.error) : undefined}>
        {canMutate ? (
          <div className="flex gap-2">
            <Input aria-label="Slack home channel ID" placeholder="C0123456789" value={channel} onChange={(event) => setChannel(event.target.value)} />
            <Button
              disabled={patch.isPending || channel.trim() === (team.slackHomeChannelId ?? "")}
              onClick={() => patch.mutate({ id: team.id, body: { slackHomeChannelId: channel.trim() || null } })}
            >
              Save
            </Button>
          </div>
        ) : (
          <p className="text-sm text-ink sm:pt-2">{team.slackHomeChannelId ?? "Not set"}</p>
        )}
      </FieldRow>
      <div className="flex flex-wrap gap-x-4 gap-y-2 py-3.5 text-sm last:pb-0.5">
        <Link to="/presence" search={{ workspace: team.id }} className={textLinkClass}>Open Presence</Link>
        <Link to="/settings/notifications" className={textLinkClass}>My DM preferences</Link>
      </div>
      <LineEditor key={team.id} open={replySetup} onOpenChange={setReplySetup} mode={{ kind: "create", preselected: { team: { id: team.id, name: team.name } } }} />
    </Section>
  );
}
