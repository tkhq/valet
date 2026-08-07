/**
 * One skill's page shell — the header every skill page carries, and the
 * markdown body under it. Shared by the two detail routes:
 * `/skills/$skillName` for a skill addressed by name,
 * `/skills/stored/$skillId` for a stored skill addressed by row id, and by
 * `/skills/new` while a skill is being written.
 *
 * The body is read-only. Where a page offers Edit or Delete, it passes them
 * in `actions` and swaps the body for the editor through `children` — the
 * same shape the memory explorer's document uses. A plugin skill's body
 * ships inside a plugin package and has no editor; a `repo` skill mirrors a
 * file in the repository it was synced from, so it has none either.
 *
 * Placeholders stay as authored. The server does not fill them here, because
 * reading a skill is not invoking it — the agent's `skill` tool fills them
 * at invoke time.
 */
import { Link } from "@tanstack/react-router";
import type { ReactNode } from "react";
import { Spinner } from "~/components/primitives";
import { Markdown } from "~/components/markdown";
import { Section } from "~/components/settings/section";

export function SkillDocument({
  title,
  description,
  meta,
  notice,
  actions,
  content,
  isLoading,
  error,
  skillName,
  children,
}: {
  title: string;
  description?: string;
  /** Mono line on the right of the header: where the skill comes from. */
  meta?: ReactNode;
  /** Shown under the header, e.g. the shadowing warning. */
  notice?: ReactNode;
  /** Edit / Delete controls, on the right of the header under `meta`. */
  actions?: ReactNode;
  content?: string;
  isLoading?: boolean;
  error?: unknown;
  /** The name the `skill` tool asks for. Absent while the body loads. */
  skillName?: string;
  /** Replaces the rendered body — the editor, when a page is editing. */
  children?: ReactNode;
}) {
  return (
    <div className="flex-1 overflow-y-auto">
      <div className="mx-auto max-w-4xl px-6 py-10">
        <Link to="/skills" className="text-xs text-muted underline-offset-2 hover:underline">
          ← Skills
        </Link>

        <div className="mt-4 flex items-end justify-between gap-4">
          <div>
            <h1 className="font-display text-2xl text-ink">{title}</h1>
            {description && <p className="mt-1 text-sm text-muted">{description}</p>}
          </div>
          <div className="flex shrink-0 flex-col items-end gap-1.5">
            {meta && <span className="font-mono text-xs text-muted">{meta}</span>}
            {actions}
          </div>
        </div>

        {notice && <div className="mt-4 text-sm text-danger-500">{notice}</div>}

        <div className="mt-10">
          {children ?? (
            <>
              {isLoading && (
                <div className="flex items-center gap-2 text-sm text-muted">
                  <Spinner size={14} /> Loading skill…
                </div>
              )}
              {!isLoading && !!error && (
                <div className="text-sm text-danger-500">
                  Could not load this skill. Open /skills to see the installed skills.
                </div>
              )}
              {!isLoading && !error && content !== undefined && (
                <Section
                  title="Playbook"
                  description={`The assistant reads this text when it calls the skill tool with name "${skillName ?? title}".`}
                >
                  <div className="pt-4">
                    <Markdown>{content}</Markdown>
                  </div>
                </Section>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}
