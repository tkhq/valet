/**
 * One tile per skill on `/skills`, built from the same parts as
 * `IntegrationRow`: a monogram, the friendly name, a clamped description,
 * and an `mt-auto` footer that pairs mono metadata on the left with the
 * action on the right.
 *
 * A plugin skill's monogram takes the OWNING PLUGIN's brand color and the
 * skill's own initial, so skills from one plugin read as a family in a mixed
 * grid. A stored skill takes the moss accent instead — the colour separates
 * a skill a plugin ships from a skill stored for the caller at a glance, and
 * the origin badge says it in words.
 *
 * The mono footer carries the skill's ID — the string an agent references,
 * which the title's display name hides. The owning plugin is appended only
 * when it differs from the skill name: most plugins ship one skill of the
 * same name, so printing it always would repeat the title.
 *
 * Every card opens the skill's page. A plugin skill goes to the name route.
 * A stored skill goes to the row-id route instead: a shadowed skill shares
 * its name with the skill shadowing it, so the name route cannot reach it.
 */
import { Link } from "@tanstack/react-router";
import type { SkillSummary, StoredSkillSummary } from "@valet/api/wire";
import { Badge } from "~/components/primitives";
import { brandHex } from "~/components/integrations/service-mark";
import { displayName } from "~/components/integrations/display-name";
import { cn } from "~/lib/cn";
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

/** Where the markdown lives, in the words a reader needs. */
export function originLabel(skill: SkillSummary): string {
  if (skill.origin === "plugin") return "Plugin";
  if (skill.origin === "repo") return "Repo";
  if (skill.ownerType === "org") return "Org";
  return skill.ownerType === "team" ? "Team" : "Yours";
}

export function SkillCard({ skill }: { skill: SkillSummary }) {
  const title = displayName(skill.name);
  const plugin = skill.origin === "plugin" ? displayName(skill.plugin) : undefined;
  const showPlugin = plugin !== undefined && plugin !== title;

  const body = (
    <>
      <div className="flex items-start gap-3">
        <span
          aria-hidden="true"
          className={cn(
            "grid h-9 w-9 shrink-0 place-items-center rounded-lg text-sm font-semibold text-white",
            skill.origin !== "plugin" && "bg-moss",
          )}
          style={skill.origin === "plugin" ? { backgroundColor: brandHex(skill.plugin) } : undefined}
        >
          {title.charAt(0).toUpperCase()}
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="truncate text-sm font-medium text-ink">{title}</span>
            <ScopeBadge scope={scopeForSkill(skill)} />
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

  const shell = "group flex flex-col rounded-lg border border-line bg-paper p-4 text-left transition-shadow hover:shadow-sm";

  if (skill.origin === "plugin") {
    return (
      <Link to="/skills/$skillName" params={{ skillName: skill.name }} className={shell}>
        {body}
      </Link>
    );
  }

  return (
    <Link to="/skills/stored/$skillId" params={{ skillId: skill.id }} className={shell}>
      {body}
    </Link>
  );
}
