/**
 * One skill's markdown body in a centered document shell, shared by the two
 * detail routes: `/skills/$skillName` for a skill addressed by name, and
 * `/skills/stored/$skillId` for a stored skill addressed by row id.
 *
 * Read-only, both times. A plugin skill's body ships inside a plugin
 * package, and a stored skill is authored either in the repository it came
 * from or through the assistant — see
 * docs/specs/2026-08-05-agent-skills-design.md.
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
  content,
  isLoading,
  error,
  skillName,
}: {
  title: string;
  description?: string;
  /** Mono line on the right of the header: where the skill comes from. */
  meta?: ReactNode;
  /** Shown under the header, e.g. the shadowing warning. */
  notice?: ReactNode;
  content?: string;
  isLoading: boolean;
  error: unknown;
  /** The name the `skill` tool asks for. Absent while the body loads. */
  skillName?: string;
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
          {meta && <span className="shrink-0 font-mono text-xs text-muted">{meta}</span>}
        </div>

        {notice && <div className="mt-4 text-sm text-danger-500">{notice}</div>}

        <div className="mt-10">
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
        </div>
      </div>
    </div>
  );
}
