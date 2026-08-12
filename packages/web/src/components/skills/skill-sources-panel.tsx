/**
 * Tracked skill repositories, above the catalog grid on `/skills`.
 *
 * Valet mirrors a repository's `SKILL.md` files into the catalog and re-reads
 * the repository on a schedule. This panel is where a repository is added,
 * re-read on demand, and removed.
 *
 * PUBLIC repositories only, and the panel says so where the box is: nothing
 * here sends a GitHub credential, so a private repository fails with the same
 * 404 a typo gives.
 *
 * A mirrored skill is not editable, so the rows carry no edit action. Removing
 * a source removes the skills it brought in, which is why the button is
 * "Remove" and not "Disable".
 */
import { useState, type FormEvent } from "react";
import { Badge, Button, Input, Spinner } from "~/components/primitives";
import { relativeTime } from "~/lib/relative-time";
import { OWNER_SELF, OwnerPicker } from "~/components/owner-picker";
import { useTeams } from "~/api/settings";
import {
  useAddSkillSource,
  useRemoveSkillSource,
  useSkillSources,
  useSyncSkillSource,
  type SkillSourceSummary,
} from "~/api/skill-sources";

export function SkillSourcesPanel() {
  const { data, isLoading, error } = useSkillSources();
  const teams = useTeams();
  const sources = data?.sources ?? [];
  const [open, setOpen] = useState(false);
  const [repo, setRepo] = useState("");
  const [teamId, setTeamId] = useState(OWNER_SELF);
  const add = useAddSkillSource();

  const teamName = new Map((teams.data?.teams ?? []).map((t) => [t.id, t.name]));

  function submit(e: FormEvent) {
    e.preventDefault();
    const value = repo.trim();
    if (value.length === 0) return;
    add.mutate(
      { repo: value, ...(teamId === OWNER_SELF ? {} : { teamId }) },
      { onSuccess: () => setTeamId(OWNER_SELF) },
    );
    setRepo("");
  }

  return (
    <section className="rounded-lg border border-line bg-paper">
      <div className="flex items-center justify-between gap-3 px-4 py-3">
        <h2 className="text-sm font-medium text-ink">Repositories</h2>
        <Button variant="ghost" size="sm" onClick={() => setOpen((v) => !v)}>
          {open ? "Cancel" : "Import from GitHub"}
        </Button>
      </div>

      {open && (
        <form
          aria-label="Import a skill repository"
          onSubmit={submit}
          className="border-t border-line px-4 py-3"
        >
          <div className="flex items-center gap-2">
            <Input
              autoFocus
              value={repo}
              onChange={(e) => setRepo(e.target.value)}
              placeholder="owner/repo or GitHub URL"
              aria-label="Repository"
            />
            <Button type="submit" size="sm" disabled={add.isPending}>
              {add.isPending ? <Spinner size={14} /> : "Import"}
            </Button>
          </div>
          <div className="mt-2">
            <OwnerPicker
              id="skill-source-owner"
              value={teamId}
              onChange={setTeamId}
              help="A team repository syncs skills for every member's sessions."
            />
          </div>
          <p className="mt-2 text-xs text-muted">Public repositories only.</p>
          {add.error && <p className="mt-1 text-xs text-danger-500">{add.error.message}</p>}
        </form>
      )}

      {isLoading && (
        <div className="flex items-center gap-2 border-t border-line px-4 py-3 text-sm text-muted">
          <Spinner size={14} /> Loading repositories…
        </div>
      )}
      {!isLoading && error && (
        <div className="border-t border-line px-4 py-3 text-sm text-danger-500">
          Could not load repositories. Check that the server is running, then reload.
        </div>
      )}
      {!isLoading && !error && sources.length === 0 && !open && (
        <div className="border-t border-line px-4 py-3 text-sm text-muted">
          No repositories yet.
        </div>
      )}

      {sources.map((source) => (
        <SourceRow key={source.id} source={source} teamName={teamName} />
      ))}
    </section>
  );
}

function SourceRow({
  source,
  teamName,
}: {
  source: SkillSourceSummary;
  teamName: Map<string, string>;
}) {
  const sync = useSyncSkillSource();
  const remove = useRemoveSkillSource();
  const pinned = [source.ref, source.subpath].filter((part) => part.length > 0).join(" · ");

  return (
    <div className="flex items-start justify-between gap-3 border-t border-line px-4 py-3">
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="truncate font-mono text-sm text-ink">{source.repo}</span>
          {pinned.length > 0 && (
            <span className="shrink-0 font-mono text-xs text-muted">{pinned}</span>
          )}
          {source.ownerType === "team" && (
            <Badge variant="accent" className="shrink-0">
              {teamName.get(source.ownerId) ?? "Team"}
            </Badge>
          )}
        </div>
        <p className="mt-0.5 text-xs text-muted">
          {source.skillCount} skill{source.skillCount === 1 ? "" : "s"} ·{" "}
          {source.lastSyncedAt === null ? "never synced" : `synced ${relativeTime(source.lastSyncedAt)}`}
        </p>
        {source.lastMessage && (
          <p
            className={
              source.status === "error"
                ? "mt-1 text-xs leading-relaxed text-danger-500"
                : "mt-1 text-xs leading-relaxed text-muted"
            }
          >
            {source.lastMessage}
          </p>
        )}
      </div>
      <div className="flex shrink-0 items-center gap-1">
        <Button
          variant="ghost"
          size="sm"
          disabled={sync.isPending}
          onClick={() => sync.mutate(source.id)}
        >
          {sync.isPending ? <Spinner size={14} /> : "Sync"}
        </Button>
        <Button
          variant="ghost"
          size="sm"
          disabled={remove.isPending}
          onClick={() => remove.mutate(source.id)}
        >
          Remove
        </Button>
      </div>
    </div>
  );
}
