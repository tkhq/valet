/**
 * Tracked skill repositories. Two homes: the panel above the grid on
 * `/skills`, where the skills a repository mirrors actually live, and the
 * org panel on `/settings/organization/library`, which pins the org so an
 * admin sees the library every member reads.
 *
 * Valet mirrors a repository's `SKILL.md` files into the catalog and re-reads
 * the repository on a schedule. This panel is where a repository is added,
 * re-read on demand, and removed.
 *
 * A public repository needs no GitHub connection. A private one is read with
 * the credential the source's OWNER holds: the adding person's own GitHub
 * account for a personal or team source, and the org's GitHub App for an org
 * source. The hint under the box says which of the two this panel files, so
 * an org admin is not told to connect a personal account.
 *
 * A mirrored skill is not editable, so the rows carry no edit action. Removing
 * a source removes the skills it brought in, which is why the button is
 * "Remove" and not "Disable".
 *
 * `owner` pins the listing to ONE owner, server-side. The `/skills` panel
 * sends none and lists every source the caller reaches — their own, their
 * teams', and the org's — with the row badge carrying the scope, so tracking
 * a repository no longer starts with picking which page to open. A row's
 * scope was the reason there were two personal pages; now it is a badge.
 *
 * A new source goes to the org when `owner` names it, and otherwise to the
 * active workspace, which the nav switcher sets: your own, or a team. No
 * Owner select asks a second time.
 *
 * `readOnly` hides the add form and the per-row Sync/Remove actions — the org
 * panel passes it for a member, who may read org sources but not change them.
 *
 * The listing is paged. `cursors` is the stack of cursors walked so far and
 * belongs to the route, which keeps it in the URL — see `~/lib/cursor-stack`
 * for why the pager cannot own it.
 */
import { useState, type FormEvent } from "react";
import { Button, Input, Spinner } from "~/components/primitives";
import { Pager } from "~/components/pager";
import { relativeTime } from "~/lib/relative-time";
import { errorText } from "~/lib/error-text";
import { OwnerBadge } from "~/components/owner-badge";
import { currentCursor, pageNumber, popCursor, pushCursor } from "~/lib/cursor-stack";
import { useWorkspaceScope } from "~/lib/workspace-scope";
import {
  useAddSkillSource,
  useRemoveSkillSource,
  useSkillSources,
  useSyncSkillSource,
  type SkillSourceSummary,
} from "~/api/skill-sources";
import { ScopeBadge, scopeForOwnerType } from "./scope-badge";

/** The one owner a panel pins its listing to. */
export interface SourcesOwner {
  type: "user" | "team" | "org";
  id: string;
}

export function SkillSourcesPanel({
  owner,
  readOnly = false,
  cursors,
  onCursorsChange,
}: {
  owner?: SourcesOwner;
  readOnly?: boolean;
  cursors: string[];
  onCursorsChange: (next: string[]) => void;
}) {
  const cursor = currentCursor(cursors);
  const { data, isLoading, error } = useSkillSources({
    ...(owner === undefined ? {} : { ownerType: owner.type, ownerId: owner.id }),
    ...(cursor === undefined ? {} : { cursor }),
  });
  const sources = data?.sources ?? [];
  const hasNext = data?.nextCursor != null;
  const paged = !isLoading && !error && (cursors.length > 0 || hasNext);
  const [open, setOpen] = useState(false);
  const [repo, setRepo] = useState("");
  const add = useAddSkillSource();
  // The active workspace owns a new source unless `owner` pins the org.
  // There was an Owner select in this form. It asked again what the nav's
  // workspace switcher had already answered, and the two could disagree —
  // the panel could list one workspace's repositories while the form filed a
  // new one under another.
  const workspace = useWorkspaceScope();

  function submit(e: FormEvent) {
    e.preventDefault();
    const value = repo.trim();
    if (value.length === 0) return;
    add.mutate(
      owner?.type === "org"
        ? { repo: value, ownerType: "org" }
        : { repo: value, ...(workspace.teamId === undefined ? {} : { teamId: workspace.teamId }) },
    );
    setRepo("");
  }

  return (
    <section className="rounded-lg border border-line bg-paper">
      <div className="flex items-center justify-between gap-3 px-4 py-3">
        <h2 className="text-sm font-medium text-ink">Repositories</h2>
        {!readOnly && (
          <Button variant="ghost" size="sm" onClick={() => setOpen((v) => !v)}>
            {open ? "Cancel" : "Import from GitHub"}
          </Button>
        )}
      </div>

      {!readOnly && open && (
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
          {/* Names what actually governs access, and names the credential
              THIS panel would use. An org panel files an org source, which
              reads through the GitHub App, so telling its admin to connect a
              personal account would send them to the wrong screen. */}
          <p className="mt-2 text-xs text-muted">
            A public repository needs no GitHub connection.{" "}
            {owner?.type === "org"
              ? "A private one is read with the GitHub App installed for this organization."
              : "A private one is read with your connected GitHub account."}
          </p>
          {add.error && <p className="mt-1 text-xs text-danger-500">{errorText(add.error)}</p>}
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
        <SourceRow key={source.id} source={source} readOnly={readOnly} />
      ))}

      {/* The wrapper carries a rule above the pager, so it is conditional on
          the pager itself and not only on the data being in. An empty
          bordered strip under a one-page list is a line with nothing in it. */}
      {paged && (
        <div className="border-t border-line px-4 pb-4">
          <Pager
            label="repositories"
            page={pageNumber(cursors)}
            hasPrevious={cursors.length > 0}
            hasNext={hasNext}
            onPrevious={() => onCursorsChange(popCursor(cursors))}
            onNext={() => {
              if (data?.nextCursor != null) onCursorsChange(pushCursor(cursors, data.nextCursor));
            }}
          />
        </div>
      )}
    </section>
  );
}

function SourceRow({ source, readOnly }: { source: SkillSourceSummary; readOnly: boolean }) {
  const sync = useSyncSkillSource();
  const remove = useRemoveSkillSource();
  const pinned = [source.ref, source.subpath].filter((part) => part.length > 0).join(" · ");

  return (
    <div className="flex items-start justify-between gap-3 border-t border-line px-4 py-3">
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="truncate font-mono text-sm text-ink">{source.repo}</span>
          {/* One badge for the scope axis, as on `SkillCard`: a team row takes
              `OwnerBadge`, which names the team and links to its assistant. */}
          {source.ownerType === "team" ? (
            <OwnerBadge ownerType={source.ownerType} ownerId={source.ownerId} />
          ) : (
            <ScopeBadge scope={scopeForOwnerType(source.ownerType)} />
          )}
          {pinned.length > 0 && (
            <span className="shrink-0 font-mono text-xs text-muted">{pinned}</span>
          )}
        </div>
        <p className="mt-0.5 text-xs text-muted">
          {source.skillCount} skill{source.skillCount === 1 ? "" : "s"} ·{" "}
          {source.lastSyncedAt === null ? "never synced" : `synced ${relativeTime(source.lastSyncedAt)}`}
        </p>
        {/* A sync that imported nothing writes its reason here, so "0 skills"
            and "Valet could not read it" and "it holds no SKILL.md" stop
            looking the same. A warning takes the warning colour rather than
            the muted one: muted text beside "0 skills" reads as a footnote,
            and this line is the answer. */}
        {source.lastMessage && (
          <p
            className={
              source.status === "error"
                ? "mt-1 text-xs leading-relaxed text-danger-500"
                : source.status === "warning"
                  ? "mt-1 text-xs leading-relaxed text-warning-fg"
                  : "mt-1 text-xs leading-relaxed text-muted"
            }
          >
            {source.lastMessage}
          </p>
        )}
        {/* What the scan skipped, after a sync this person asked for. The
            exclusion rule can be wrong — a real skill can sit under a name
            the scan skips — so the count has to be visible somewhere. It is
            NOT on the source row: a repository can hold hundreds of these
            legitimately (a dependency tree, a downloaded agent plugin), and a
            standing warning about them teaches people to ignore the row. The
            one case that does reach the row is an excluded path holding a
            skill this source already mirrors, which warns by path. */}
        {sync.data !== undefined && sync.data.excluded > 0 && (
          <p className="mt-1 text-xs leading-relaxed text-muted">
            Scanned {sync.data.discovered} SKILL.md {sync.data.discovered === 1 ? "file" : "files"}.
            Skipped {sync.data.excluded} in directories Valet does not scan: dependencies, build
            output, tests, and downloaded agent plugins.
          </p>
        )}
        {sync.error && (
          <p className="mt-1 text-xs leading-relaxed text-danger-500">{errorText(sync.error)}</p>
        )}
        {remove.error && (
          <p className="mt-1 text-xs leading-relaxed text-danger-500">{errorText(remove.error)}</p>
        )}
      </div>
      {!readOnly && (
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
      )}
    </div>
  );
}
