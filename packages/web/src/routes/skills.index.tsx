import { useState } from "react";
import { createFileRoute } from "@tanstack/react-router";
import type { SkillSummary, StoredSkillSummary } from "@valet/api/wire";
import { useSkills } from "~/api/skills";
import { Button, Spinner } from "~/components/primitives";
import { SkillCard } from "~/components/skills/skill-card";
import { SkillEditor } from "~/components/skills/skill-editor";
import { displayName } from "~/components/integrations/display-name";

/**
 * `/skills` — the markdown playbooks the assistant can pull into a turn.
 * Two kinds sit in one grid: the skills the installed plugins ship, which
 * are read-only, and the skills stored for the caller, which this page
 * creates, edits, and deletes. Each card carries an origin badge.
 *
 * One grid, sorted by name. Grouping into a section per plugin was tried and
 * reverted: 8 of the 9 plugins ship exactly one skill, so it produced 8
 * headed sections holding a single card each and stretched 11 items over
 * roughly nine screens. The origin belongs on the card, not in a header.
 *
 * The editor opens inline above the grid rather than in a dialog, because a
 * playbook is a document: it needs the width and the vertical room.
 */
export const Route = createFileRoute("/skills/")({
  component: SkillsIndexPage,
});

/** Sorted by display name so the page order is stable whatever order the
 * server returns. */
function sortByName(skills: SkillSummary[]): SkillSummary[] {
  return [...skills].sort((a, b) => displayName(a.name).localeCompare(displayName(b.name)));
}

/** "new" opens an empty form; a row id opens that skill; null shows none. */
type EditorState = { mode: "new" } | { mode: "edit"; id: string } | null;

export function SkillsIndexPage() {
  const { data, isLoading, error } = useSkills();
  const [editor, setEditor] = useState<EditorState>(null);
  const skills = data?.skills ?? [];
  const sorted = sortByName(skills);
  const pluginCount = new Set(
    skills.flatMap((s) => (s.origin === "plugin" ? [s.plugin] : [])),
  ).size;
  const storedCount = skills.filter((s) => s.origin !== "plugin").length;

  const openEdit = (skill: StoredSkillSummary) => setEditor({ mode: "edit", id: skill.id });

  return (
    <div className="flex-1 overflow-y-auto">
      <div className="mx-auto max-w-4xl px-6 py-10">
        <div className="flex items-end justify-between gap-4">
          <div>
            <h1 className="font-display text-2xl text-ink">Skills</h1>
            <p className="mt-1 text-sm text-muted">
              Playbooks your assistant reads on demand. Plugins bring their own; write your own here.
            </p>
          </div>
          <div className="flex shrink-0 items-center gap-3">
            {!isLoading && !error && skills.length > 0 && (
              <span className="font-mono text-xs text-muted">
                {skills.length} skill{skills.length === 1 ? "" : "s"} · {pluginCount} plugin
                {pluginCount === 1 ? "" : "s"} · {storedCount} yours
              </span>
            )}
            <Button size="sm" onClick={() => setEditor({ mode: "new" })}>
              New skill
            </Button>
          </div>
        </div>

        {editor && (
          <div className="mt-8">
            <SkillEditor
              key={editor.mode === "edit" ? editor.id : "new"}
              skillId={editor.mode === "edit" ? editor.id : null}
              onClose={() => setEditor(null)}
            />
          </div>
        )}

        <div className="mt-10 space-y-12">
          {isLoading && (
            <div className="flex items-center gap-2 text-sm text-muted">
              <Spinner size={14} /> Loading skills…
            </div>
          )}
          {!isLoading && error && (
            <div className="text-sm text-danger-500">
              Could not load skills. Check that the server is running, then reload.
            </div>
          )}
          {!isLoading && !error && skills.length === 0 && (
            <div className="text-sm text-muted">
              No skills yet. Plugins bring their own — see Integrations — or write one with New
              skill.
            </div>
          )}

          {!isLoading && !error && sorted.length > 0 && (
            <div className="grid gap-3 sm:grid-cols-2">
              {sorted.map((skill) => (
                <SkillCard
                  key={skill.origin === "plugin" ? `plugin:${skill.name}` : skill.id}
                  skill={skill}
                  onEdit={openEdit}
                />
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
