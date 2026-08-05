/**
 * One tile per skill on `/skills`, built from the same parts as
 * `IntegrationRow`: a monogram, the friendly name, a clamped description,
 * and an `mt-auto` footer that pairs mono metadata on the left with the
 * action on the right.
 *
 * The monogram takes the OWNING PLUGIN's brand color and the skill's own
 * initial, so every card in a plugin's section reads as one family while
 * each card stays distinguishable.
 */
import { Link } from "@tanstack/react-router";
import type { SkillSummary } from "@valet/api/wire";
import { brandHex } from "~/components/integrations/integration-row";
import { displayName } from "~/components/integrations/display-name";

export function SkillCard({ skill }: { skill: SkillSummary }) {
  const title = displayName(skill.name);

  return (
    <Link
      to="/skills/$skillName"
      params={{ skillName: skill.name }}
      className="group flex flex-col rounded-lg border border-line bg-paper p-4 transition-shadow hover:shadow-sm"
    >
      <div className="flex items-start gap-3">
        <span
          aria-hidden="true"
          className="grid h-9 w-9 shrink-0 place-items-center rounded-lg text-sm font-semibold text-white"
          style={{ backgroundColor: brandHex(skill.plugin) }}
        >
          {title.charAt(0).toUpperCase()}
        </span>
        <div className="min-w-0 flex-1">
          <span className="truncate text-sm font-medium text-ink">{title}</span>
          {skill.description && (
            <p className="mt-0.5 line-clamp-2 text-xs leading-relaxed text-muted">
              {skill.description}
            </p>
          )}
        </div>
      </div>

      <div className="mt-auto flex items-center justify-between gap-3 pt-4">
        <span className="truncate font-mono text-xs text-muted">
          {skill.name}
          {skill.takesArgs && " · takes arguments"}
        </span>
        <span className="shrink-0 text-xs text-moss underline-offset-2 group-hover:underline">
          Read
        </span>
      </div>
    </Link>
  );
}
