/**
 * One tile per skill on `/skills`, built from the same parts as
 * `IntegrationRow`: a service icon, the friendly name, a clamped
 * description, and an `mt-auto` footer that pairs mono metadata on the left
 * with the action on the right.
 *
 * A plugin skill takes the OWNING PLUGIN's icon — its brand mark, or the
 * plugin's brand colour under the skill's own initial when the plugin has
 * no mark. Either way skills from one plugin read as a family in a mixed
 * grid. A stored skill takes the moss accent instead — the colour separates
 * a skill a plugin ships from a skill stored for the caller at a glance, and
 * the scope badge says it in words.
 *
 * The mono footer carries the skill's ID — the string an agent references,
 * which the title's display name hides. The owning plugin is appended only
 * when it differs from the skill name: most plugins ship one skill of the
 * same name, so printing it always would repeat the title.
 *
 * Every card opens the skill's page. A plugin skill goes to the name route.
 * A stored skill goes to the row-id route instead: a shadowed skill shares
 * its name with the skill shadowing it, so the name route cannot reach it.
 * That link covers the card instead of wrapping it, because the owner badge
 * in the title row is a link too and an anchor cannot hold another anchor.
 */
import { Link } from "@tanstack/react-router";
import type { SkillSummary, StoredSkillSummary } from "@valet/api/wire";
import { Badge } from "~/components/primitives";
import { OwnerBadge } from "~/components/owner-badge";
import { ServiceIcon } from "~/components/service-icon";
import { displayName } from "~/components/integrations/display-name";
import { ScopeBadge, scopeForSkill } from "./scope-badge";

/**
 * What to do about a skill another skill of the same name keeps out of every
 * session. The fix follows where the skill is authored: a `local` skill is
 * renamed on its own page, and a `repo` skill in the repository that owns
 * it, because the next sync overwrites anything changed here.
 */
export function shadowNote(skill: StoredSkillSummary): string {
  const fix =
    skill.origin === "repo"
      ? "Rename it in the repository it came from."
      : "Rename this one to make the assistant read it.";
  return `Shadowed by another skill of the same name. ${fix}`;
}

/**
 * Where the markdown lives, in the words a reader needs. Who owns it is a
 * second axis — `OwnerBadge` names the owning team, so this label leaves the
 * team case to it.
 *
 * The org library is the exception: it has no owner badge, because there is
 * no team assistant to link an org row to. So `org` is named here. Without
 * that case an org skill would read as "Yours", and the reader would think a
 * read-only row was theirs to edit.
 */
export function originLabel(skill: SkillSummary): string {
  if (skill.origin === "plugin") return "Plugin";
  if (skill.origin === "repo") return "Repo";
  if (skill.ownerType === "org") return "Org";
  return "Yours";
}

export function SkillCard({ skill }: { skill: SkillSummary }) {
  const title = displayName(skill.name);
  const plugin = skill.origin === "plugin" ? displayName(skill.plugin) : undefined;
  const showPlugin = plugin !== undefined && plugin !== title;

  const body = (
    <>
      <div className="flex items-start gap-3">
        <ServiceIcon
          slug={skill.origin === "plugin" ? skill.plugin : undefined}
          label={title}
          tone={skill.origin === "plugin" ? "brand" : "accent"}
        />
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="truncate text-sm font-medium text-ink">{title}</span>
            {/* One badge for the scope axis. A team row takes `OwnerBadge`
                in place of the generic Team badge, because it names the team
                and links to that team's assistant. */}
            {skill.origin !== "plugin" && skill.ownerType === "team" ? (
              <OwnerBadge ownerType={skill.ownerType} ownerId={skill.ownerId} />
            ) : (
              <ScopeBadge scope={scopeForSkill(skill)} />
            )}
            {skill.origin === "repo" && <Badge variant="neutral">Repo</Badge>}
            {skill.origin !== "plugin" && skill.invocation === "prompt" && (
              <Badge variant="neutral">prompt</Badge>
            )}
          </div>
          {skill.description && (
            <p className="mt-0.5 line-clamp-2 text-xs leading-relaxed text-muted">
              {skill.description}
            </p>
          )}
          {skill.origin !== "plugin" && skill.shadowed && (
            <p className="mt-1 text-xs leading-relaxed text-danger-500">{shadowNote(skill)}</p>
          )}
        </div>
      </div>

      <div className="mt-auto flex items-center justify-between gap-3 pt-4">
        <span className="truncate font-mono text-xs text-muted">
          {skill.name}
          {showPlugin && ` · ${plugin}`}
          {skill.takesArgs && " · takes arguments"}
        </span>
        <span className="shrink-0 text-xs text-moss underline-offset-2 group-hover:underline">
          Read
        </span>
      </div>
    </>
  );

  const shell =
    "group relative flex flex-col rounded-lg border border-line bg-paper p-4 text-left transition-shadow hover:shadow-sm";
  // The card's own link, stretched over the card. It carries the name a
  // reader hears, because it holds no text of its own.
  const cover = "absolute inset-0 rounded-lg";
  const label = `Read ${title}`;

  return (
    <div className={shell}>
      {skill.origin === "plugin" ? (
        <Link
          to="/skills/$skillName"
          params={{ skillName: skill.name }}
          className={cover}
          aria-label={label}
        />
      ) : (
        <Link
          to="/skills/stored/$skillId"
          params={{ skillId: skill.id }}
          className={cover}
          aria-label={label}
        />
      )}
      {body}
    </div>
  );
}
