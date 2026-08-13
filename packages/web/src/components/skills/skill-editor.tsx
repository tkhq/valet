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
import type { CreateSkillRequest, SkillResponse, UpdateSkillRequest } from "@valet/api/wire";
import { Button, Input, Label, Spinner, Textarea } from "~/components/primitives";
import { MarkdownEditor } from "~/components/markdown-editor";
import { useCreateSkill, useUpdateSkill } from "~/api/skills";
import { useOrg, useTeams } from "~/api/settings";
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

/**
 * Renders a prompt body the way a session reads it, with the argument markers
 * shown in place: `$1`→`⟨arg1⟩`, `$2`→`⟨arg2⟩`, and `$@` or `$ARGUMENTS`→
 * `⟨all args⟩`. Display only — a pure string replace, so the editor can show
 * where the args land without running the engine substitution.
 *
 * `$ARGUMENTS` is replaced before `$@`, and both before the numbered markers,
 * so a longer token never leaves a stray `$` behind a shorter one.
 */
export function previewPromptBody(body: string): string {
  return body
    .replace(/\$ARGUMENTS\b/g, "⟨all args⟩")
    .replace(/\$@/g, "⟨all args⟩")
    .replace(/\$(\d+)/g, (_m, n: string) => `⟨arg${n}⟩`);
}

/** Owner of a new skill: the caller, a team the caller belongs to, or the org
 * when the caller is an org admin. The value is "" for the caller, `OWNER_ORG`
 * for the org, or a `teamId` for a team. A stored skill does not change owner,
 * so the field is create-only. */
const OWNER_SELF = "";
const OWNER_ORG = "org";

export function SkillEditor({
  skill,
  defaultScope,
  onSaved,
  onCancel,
}: {
  /** Absent to create. Present to edit — its body must already be loaded. */
  skill?: SkillResponse;
  /** Preselects the owner on a new skill. `"org"` is honored only for an org
   * admin; anything else falls back to the caller. */
  defaultScope?: "personal" | "org";
  onSaved: (saved: SkillResponse) => void;
  onCancel: () => void;
}) {
  const editing = skill !== undefined;
  const create = useCreateSkill();
  const update = useUpdateSkill();
  const teams = useTeams();
  const org = useOrg();
  const isAdmin = org.data?.callerRole === "admin";

  const [name, setName] = useState(skill?.name ?? "");
  const [description, setDescription] = useState(skill?.description ?? "");
  const [content, setContent] = useState(skill?.content ?? "");
  // Preselect the org scope only for an admin — a member never gets the
  // option, so a member landing on `?scope=org` falls back to a personal skill.
  const [teamId, setTeamId] = useState(defaultScope === "org" && isAdmin ? OWNER_ORG : OWNER_SELF);
  const [invocation, setInvocation] = useState<"context" | "prompt">(
    skill?.invocation === "prompt" ? "prompt" : "context",
  );
  const [argHint, setArgHint] = useState(skill?.argHint ?? "");

  const pending = create.isPending || update.isPending;
  const error = create.error ?? update.error;
  const complete = name.trim() !== "" && description.trim() !== "" && content.trim() !== "";

  function submit() {
    if (!complete || pending) return;
    // A `context` skill takes no argHint, so send it only for a `prompt`.
    const argFields =
      invocation === "prompt" && argHint.trim() !== "" ? { argHint: argHint.trim() } : {};
    if (editing && skill) {
      const body: UpdateSkillRequest = { name, description, content, invocation, ...argFields };
      update.mutate({ id: skill.id, body }, { onSuccess: onSaved });
      return;
    }
    // An org skill needs admin; a member never sees the option, and a stale
    // `OWNER_ORG` (admin flag not yet loaded) falls back to a personal skill.
    const ownerFields =
      teamId === OWNER_ORG
        ? isAdmin
          ? { ownerType: "org" as const }
          : {}
        : teamId === OWNER_SELF
          ? {}
          : { teamId };
    const body: CreateSkillRequest = {
      name,
      description,
      content,
      invocation,
      ...argFields,
      ...ownerFields,
    };
    create.mutate(body, { onSuccess: onSaved });
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

        {!editing && ((teams.data?.teams.length ?? 0) > 0 || isAdmin) && (
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
              {/* Org visible only to an admin — the create API rejects an org
                  skill from a member with a 403. */}
              {isAdmin && <option value={OWNER_ORG}>Organization</option>}
            </select>
            <p className="text-xs text-muted">
              A team or org skill reaches every member's sessions.
            </p>
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

      <div className="grid gap-4 sm:grid-cols-2">
        <div className="space-y-1.5">
          <Label htmlFor="skill-invocation">Invocation</Label>
          <select
            id="skill-invocation"
            value={invocation}
            onChange={(e) => setInvocation(e.target.value === "prompt" ? "prompt" : "context")}
            className="h-9 w-full rounded border border-[--border] bg-[--bg] px-3 text-sm text-[--fg]"
          >
            <option value="context">Context — load as reference</option>
            <option value="prompt">Prompt — substitute args and send</option>
          </select>
          <p className="text-xs text-muted">
            A context skill loads the body as reference. A prompt skill fills its arguments and
            sends the body as the message.
          </p>
        </div>

        {invocation === "prompt" && (
          <div className="space-y-1.5">
            <Label htmlFor="skill-arg-hint">Argument hint</Label>
            <Input
              id="skill-arg-hint"
              value={argHint}
              onChange={(e) => setArgHint(e.target.value)}
              placeholder="<topic>"
              autoComplete="off"
              spellCheck={false}
            />
            <p className="text-xs text-muted">
              Shown in the command palette for the first argument.
            </p>
          </div>
        )}
      </div>

      {invocation === "prompt" && (
        <div className="space-y-1.5">
          <Label>Preview</Label>
          <p className="whitespace-pre-wrap rounded border border-line bg-paper px-3 py-2 text-xs text-muted">
            {previewPromptBody(content)}
          </p>
          <p className="text-xs text-muted">
            {"$1"} and {"$2"} fill the arguments in order; {"$@"} fills all of them.
          </p>
        </div>
      )}

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
