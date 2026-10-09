/**
 * One row per skill on `/skills`, in the same grouped-list style as the
 * Integrations rows (settings-redesign spec, "Skills"): a service icon, the
 * friendly name with its badges, one line of description, and a mono line
 * of metadata.
 *
 * A plugin skill takes the OWNING PLUGIN's icon — its brand mark, or the
 * plugin's brand colour under the skill's own initial when the plugin has
 * no mark. Either way skills from one plugin read as a family in a mixed
 * list. A stored skill takes the moss accent instead — the colour separates
 * a skill a plugin ships from a skill stored for the caller at a glance, and
 * the scope badge says it in words.
 *
 * The mono line carries the skill's ID — the string an agent references,
 * which the title's display name hides. The owning plugin is appended only
 * when it differs from the skill name: most plugins ship one skill of the
 * same name, so printing it always would repeat the title.
 *
 * Every row opens the skill's page. A plugin skill goes to the name route.
 * A stored skill goes to the row-id route instead: a shadowed skill shares
 * its name with the skill shadowing it, so the name route cannot reach it.
 * That link covers the row instead of wrapping it, because the owner badge
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
  if (skill.ownerType === "team") return "Team";
  return "Yours";
}

export function SkillCard({ skill }: { skill: SkillSummary }) {
  const title = displayName(skill.name);
  const plugin = skill.origin === "plugin" ? displayName(skill.plugin) : undefined;
  const showPlugin = plugin !== undefined && plugin !== title;

  // One line: mark, name, badges, description, and the id an agent passes.
  // The description and id give way on narrow screens; the skill's page has both.
  const body = (
    <>
      <div className="flex min-h-8 items-center gap-3">
        <ServiceIcon
          slug={skill.origin === "plugin" ? skill.plugin : undefined}
          label={title}
          tone={skill.origin === "plugin" ? "brand" : "accent"}
          size="sm"
        />
        <span className="min-w-0 shrink truncate text-sm font-medium text-ink sm:max-w-[40%]">{title}</span>
        <div className="flex shrink-0 items-center gap-1.5">
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
        <span className="hidden min-w-0 flex-1 truncate text-xs text-muted sm:block">{skill.description}</span>
        <span className="ml-auto hidden max-w-[30%] shrink-0 truncate font-mono text-xs text-muted md:block" translate="no">
          {skill.name}
          {showPlugin && ` · ${plugin}`}
          {skill.takesArgs && " · takes arguments"}
        </span>
      </div>
      {skill.origin !== "plugin" && skill.shadowed && (
        <p className="mt-1 pl-9 text-xs leading-relaxed text-danger-500">{shadowNote(skill)}</p>
      )}
    </>
  );

  const shell =
    "group relative px-4 py-2 transition-colors first:rounded-t-2xl last:rounded-b-2xl hover:bg-ink-wash-strong focus-within:bg-ink-wash-strong";
  // The row's own link, stretched over the row. It carries the name a
  // reader hears, because it holds no text of its own.
  const cover = "absolute inset-0 rounded-[inherit]";
  const label = `Read ${title}`;

  return (
    <li className={shell}>
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
    </li>
  );
}
