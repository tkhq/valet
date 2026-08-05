/**
 * One tile per skill on `/skills`, built from the same parts as
 * `IntegrationRow`: a monogram, the friendly name, a clamped description,
 * and an `mt-auto` footer that pairs mono metadata on the left with the
 * action on the right.
 *
 * A plugin skill's monogram takes the OWNING PLUGIN's brand color and the
 * skill's own initial, so skills from one plugin read as a family in a mixed
 * grid. A stored skill takes the moss accent instead — the colour is what
 * separates "installed" from "written here" at a glance, and the origin
 * badge says it in words.
 *
 * The mono footer carries the skill's ID — the string an agent references,
 * which the title's display name hides. The owning plugin is appended only
 * when it differs from the skill name: most plugins ship one skill of the
 * same name, so printing it always would repeat the title.
 *
 * A plugin skill opens its read-only detail page. A stored skill opens the
 * editor on this page instead, because it is addressed by row id: a shadowed
 * skill shares its name with the skill shadowing it, so the name route
 * cannot reach it.
 */
import { Link } from "@tanstack/react-router";
import type { SkillSummary, StoredSkillSummary } from "@valet/api/wire";
import { Badge } from "~/components/primitives";
import { brandHex } from "~/components/integrations/integration-row";
import { displayName } from "~/components/integrations/display-name";
import { cn } from "~/lib/cn";

/** Where the markdown lives, in the words a reader needs. */
export function originLabel(skill: SkillSummary): string {
  if (skill.origin === "plugin") return "Plugin";
  if (skill.origin === "repo") return "Repo";
  return skill.ownerType === "team" ? "Team" : "Yours";
}

export function SkillCard({
  skill,
  onEdit,
}: {
  skill: SkillSummary;
  onEdit?: (skill: StoredSkillSummary) => void;
}) {
  const title = displayName(skill.name);
  const plugin = skill.origin === "plugin" ? displayName(skill.plugin) : undefined;
  const showPlugin = plugin !== undefined && plugin !== title;
  const shadowed = skill.origin !== "plugin" && skill.shadowed;

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
            <Badge variant={skill.origin === "plugin" ? "neutral" : "accent"}>
              {originLabel(skill)}
            </Badge>
          </div>
          {skill.description && (
            <p className="mt-0.5 line-clamp-2 text-xs leading-relaxed text-muted">
              {skill.description}
            </p>
          )}
          {shadowed && (
            <p className="mt-1 text-xs leading-relaxed text-danger-500">
              Shadowed by another skill of the same name. Rename this one to make the agent read it.
            </p>
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
          {skill.origin === "plugin" ? "Read" : "Edit"}
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
    <button type="button" onClick={() => onEdit?.(skill)} className={shell}>
      {body}
    </button>
  );
}
