/**
 * The create/edit form for a stored skill: the frontmatter fields above, and
 * the playbook body in the same split markdown editor the memory explorer
 * uses (`~/components/markdown-editor`), so a skill is written with its
 * rendering next to it.
 *
 * One component covers both modes. No `skill` prop means create; a skill
 * means edit, and the fields are seeded once at mount — the caller only
 * mounts this after the body has loaded, so there is no effect to keep the
 * draft and the query in step, and nothing overwrites what the author typed.
 *
 * Three fields are the whole skill: `name` and `description` are its
 * frontmatter, and `content` is the markdown the agent reads. The server
 * checks the name and the description against the skill spec, so this form
 * shows the server's message instead of repeating those rules.
 *
 * Only a `local` skill reaches this form. A `repo` skill mirrors a file in
 * the repository it was synced from, and the next sync would overwrite an
 * edit made here — the detail page offers no Edit for one.
 */
import { useState } from "react";
import type { SkillResponse, UpdateSkillRequest } from "@valet/api/wire";
import { Button, Input, Label, Spinner, Textarea } from "~/components/primitives";
import { MarkdownEditor } from "~/components/markdown-editor";
import { useCreateSkill, useUpdateSkill } from "~/api/skills";
import { useTeams } from "~/api/settings";
import { ApiError } from "~/api/client";

/** Server-side messages carry the corrective action; a network failure does
 * not, so it gets one here. */
export function errorText(err: unknown): string {
  if (err instanceof ApiError) {
    const payload = err.payload;
    if (typeof payload === "object" && payload !== null && "error" in payload) {
      const message = (payload as { error: unknown }).error;
      if (typeof message === "string") return message;
    }
    return err.message;
  }
  if (err instanceof Error) return `${err.message}. Check the server is running, then try again.`;
  return "Could not save the skill. Try again.";
}

/** Owner of a new skill: the caller, or a team the caller belongs to. The
 * value is the `teamId` the create route takes, and "" means the caller. A
 * stored skill does not change owner, so the field is create-only. */
const OWNER_SELF = "";

export function SkillEditor({
  skill,
  onSaved,
  onCancel,
}: {
  /** Absent to create. Present to edit — its body must already be loaded. */
  skill?: SkillResponse;
  onSaved: (saved: SkillResponse) => void;
  onCancel: () => void;
}) {
  const editing = skill !== undefined;
  const create = useCreateSkill();
  const update = useUpdateSkill();
  const teams = useTeams();

  const [name, setName] = useState(skill?.name ?? "");
  const [description, setDescription] = useState(skill?.description ?? "");
  const [content, setContent] = useState(skill?.content ?? "");
  const [teamId, setTeamId] = useState(OWNER_SELF);

  const pending = create.isPending || update.isPending;
  const error = create.error ?? update.error;
  const complete = name.trim() !== "" && description.trim() !== "" && content.trim() !== "";

  function submit() {
    if (!complete || pending) return;
    if (editing && skill) {
      const body: UpdateSkillRequest = { name, description, content };
      update.mutate({ id: skill.id, body }, { onSuccess: onSaved });
      return;
    }
    create.mutate(
      { name, description, content, ...(teamId === OWNER_SELF ? {} : { teamId }) },
      { onSuccess: onSaved },
    );
  }

  return (
    <form
      className="space-y-6"
      onSubmit={(e) => {
        e.preventDefault();
        submit();
      }}
    >
      <div className="grid gap-4 sm:grid-cols-2">
        <div className="space-y-1.5">
          <Label htmlFor="skill-name">Name</Label>
          <Input
            id="skill-name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="deploy-the-service"
            autoComplete="off"
            spellCheck={false}
          />
          <p className="text-xs text-muted">
            The name the assistant calls the skill by. Lowercase letters, numbers, and hyphens.
          </p>
        </div>

        {!editing && (teams.data?.teams.length ?? 0) > 0 && (
          <div className="space-y-1.5">
            <Label htmlFor="skill-owner">Owner</Label>
            <select
              id="skill-owner"
              value={teamId}
              onChange={(e) => setTeamId(e.target.value)}
              className="h-9 w-full rounded border border-[--border] bg-[--bg] px-3 text-sm text-[--fg]"
            >
              <option value={OWNER_SELF}>You</option>
              {teams.data?.teams.map((team) => (
                <option key={team.id} value={team.id}>
                  {team.name}
                </option>
              ))}
            </select>
            <p className="text-xs text-muted">A team skill reaches every member's sessions.</p>
          </div>
        )}
      </div>

      <div className="space-y-1.5">
        <Label htmlFor="skill-description">Description</Label>
        {/* A textarea, not an input: the spec allows 1024 characters here,
            and the description is the only thing the assistant reads when it
            decides whether to open the skill at all. */}
        <Textarea
          id="skill-description"
          rows={2}
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          placeholder="Use when you deploy the service to production."
        />
        <p className="text-xs text-muted">
          When to reach for this skill. The assistant reads this to decide.
        </p>
      </div>

      <div className="space-y-1.5">
        <Label htmlFor="skill-content">Playbook</Label>
        <MarkdownEditor
          value={content}
          onChange={setContent}
          ariaLabel="Playbook"
          placeholder="Write the steps the assistant follows."
          minHeight="45vh"
          autoFocus={!editing}
        />
      </div>

      {!!error && <p className="text-sm text-danger-500">{errorText(error)}</p>}

      <div className="flex items-center gap-2">
        <Button type="submit" size="sm" disabled={!complete || pending}>
          {pending && <Spinner size={12} />}
          {editing ? "Save" : "Create skill"}
        </Button>
        <Button type="button" size="sm" variant="ghost" onClick={onCancel} disabled={pending}>
          Cancel
        </Button>
        {!complete && (
          <span className="text-xs text-muted">Name, description, and playbook are required.</span>
        )}
      </div>
    </form>
  );
}
