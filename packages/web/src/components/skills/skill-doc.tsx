/**
 * A stored skill's page: read it, write it, edit it, remove it. Rendered by
 * `/skills/stored/$skillId` and by `/skills/stored/new`, which pass a row id
 * or null and the navigation callbacks.
 *
 * Router-free by design, like `memory-doc.tsx`: the two routes own
 * navigation and hand it in, so this renders and tests without a
 * `RouterProvider`.
 *
 * `local` and `repo` rows read the same and write differently. A `local`
 * skill is written here, or by the assistant through the `skills` actions —
 * one service backs both, so the rules do not depend on which one you use. A
 * `repo` skill mirrors a file in the repository it was synced from: the next
 * sync overwrites anything changed here, so it offers no Edit and no Delete.
 *
 * Delete is a two-click inline confirm, no dialog — the memory explorer's
 * document does the same.
 */
import { useState } from "react";
import { useDeleteSkill, useStoredSkill } from "~/api/skills";
import { displayName } from "~/components/integrations/display-name";
import { OwnerBadge } from "~/components/owner-badge";
import { originLabel, shadowNote } from "~/components/skills/skill-card";
import { SkillDocument } from "~/components/skills/skill-document";
import { SkillEditor } from "~/components/skills/skill-editor";

/** Copy for a row nobody can edit in the product. Names the corrective
 * action, per the repo's error-message rule. */
export const REPO_SKILL_NOTE =
  "This skill mirrors a repository. Edit it where it came from — the next sync would overwrite a change made here.";

/** Copy for a member viewing an org skill they may read but not change. */
export const ORG_SKILL_NOTE = "Org skills are managed by org admins.";

export function SkillDoc({
  skillId,
  defaultScope,
  onCreated,
  onDeleted,
}: {
  /** Row id to open, or null to write a new skill. */
  skillId: string | null;
  /** Preselects the owner scope on a new skill. Ignored when editing. */
  defaultScope?: "personal" | "org";
  onCreated: (id: string) => void;
  onDeleted: () => void;
}) {
  const creating = skillId === null;
  const { data: skill, isLoading, error } = useStoredSkill(skillId);
  const remove = useDeleteSkill();

  const [editing, setEditing] = useState(false);
  const [confirmingDelete, setConfirmingDelete] = useState(false);

  // A `local` skill is writable only when the server says this caller may
  // edit it. A member reading an org skill gets `editable: false`, so the
  // page shows the body read-only with no Edit/Delete.
  const writable = skill?.origin === "local" && skill.editable;
  const open = creating || editing;

  // A failed delete outranks the shadow warning: it is what the reader just
  // tried to do. The shadow warning steps aside while the editor is open —
  // the name field that fixes it is right there. A member viewing an org
  // skill sees the org note when nothing more urgent applies.
  const notice = remove.error
    ? `Could not delete this skill: ${remove.error.message}`
    : open
      ? undefined
      : skill?.shadowed
        ? shadowNote(skill)
        : skill?.origin === "repo"
          ? REPO_SKILL_NOTE
          : skill && skill.origin === "local" && !skill.editable
            ? ORG_SKILL_NOTE
            : undefined;

  return (
    <SkillDocument
      title={creating ? "New skill" : skill ? displayName(skill.name) : "Skill"}
      description={creating ? "A playbook the assistant can pull into a turn." : skill?.description}
      meta={
        skill && (
          <span className="inline-flex items-center gap-2">
            {originLabel(skill)}
            <OwnerBadge ownerType={skill.ownerType} ownerId={skill.ownerId} />
          </span>
        )
      }
      notice={notice}
      actions={
        writable && !editing ? (
          <span className="flex items-center gap-2 text-xs">
            <button
              type="button"
              onClick={() => {
                setEditing(true);
                setConfirmingDelete(false);
              }}
              className="text-muted hover:text-moss"
            >
              Edit
            </button>
            {confirmingDelete ? (
              <span className="flex items-center gap-1.5">
                <button
                  type="button"
                  onClick={() => remove.mutate(skill.id, { onSuccess: onDeleted })}
                  disabled={remove.isPending}
                  className="font-medium text-danger-500 hover:underline"
                >
                  {remove.isPending ? "Deleting…" : "Confirm delete"}
                </button>
                <button
                  type="button"
                  onClick={() => setConfirmingDelete(false)}
                  className="text-muted hover:text-ink"
                >
                  Cancel
                </button>
              </span>
            ) : (
              <button
                type="button"
                onClick={() => setConfirmingDelete(true)}
                className="text-muted hover:text-danger-500"
              >
                Delete
              </button>
            )}
          </span>
        ) : undefined
      }
      content={skill?.content}
      skillName={skill?.name}
      isLoading={!creating && isLoading}
      error={creating ? undefined : error}
    >
      {creating ? (
        <SkillEditor
          defaultScope={defaultScope}
          onSaved={(saved) => onCreated(saved.id)}
          onCancel={onDeleted}
        />
      ) : editing && skill ? (
        <SkillEditor
          skill={skill}
          onSaved={() => setEditing(false)}
          onCancel={() => setEditing(false)}
        />
      ) : undefined}
    </SkillDocument>
  );
}
