/**
 * The create/edit form for a stored skill, rendered inline on `/skills`
 * above the grid — the same inline-form shape `SourcesSection` uses for a
 * new external image, rather than a modal.
 *
 * One component covers both modes. `skillId` null means create; a row id
 * means edit, and the body is fetched by id because the catalog listing
 * carries no bodies.
 *
 * The three fields are the whole skill: `name` and `description` are its
 * frontmatter, and `content` is the markdown the agent reads. The server
 * checks the name and the description against the skill spec, so this form
 * shows the server's message instead of repeating those rules.
 */
import { useEffect, useState } from "react";
import type { UpdateSkillRequest } from "@valet/api/wire";
import { Button, Input, Label, Spinner, Textarea } from "~/components/primitives";
import { useCreateSkill, useDeleteSkill, useStoredSkill, useUpdateSkill } from "~/api/skills";
import { ApiError } from "~/api/client";

/** Server-side messages carry the corrective action; a network failure does
 * not, so it gets one here. */
function errorText(err: unknown): string {
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

export function SkillEditor({ skillId, onClose }: { skillId: string | null; onClose: () => void }) {
  const editing = skillId !== null;
  const stored = useStoredSkill(skillId);
  const create = useCreateSkill();
  const update = useUpdateSkill();
  const remove = useDeleteSkill();

  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [content, setContent] = useState("");

  // Fills the form once, when the body arrives. `filledFrom` is what makes
  // it once: without it, any re-render that hands back an equal-but-new
  // query object would refill the fields and wipe what the author typed.
  const [filledFrom, setFilledFrom] = useState<string | null>(null);
  const loaded = stored.data;
  useEffect(() => {
    if (!loaded || filledFrom === loaded.id) return;
    setName(loaded.name);
    setDescription(loaded.description ?? "");
    setContent(loaded.content);
    setFilledFrom(loaded.id);
  }, [loaded, filledFrom]);

  const pending = create.isPending || update.isPending || remove.isPending;
  const error = create.error ?? update.error ?? remove.error;

  function submit() {
    if (editing && skillId) {
      const body: UpdateSkillRequest = { name, description, content };
      update.mutate({ id: skillId, body }, { onSuccess: onClose });
      return;
    }
    create.mutate({ name, description, content }, { onSuccess: onClose });
  }

  return (
    <div className="rounded-lg border border-line bg-paper p-4">
      <div className="flex items-center justify-between gap-4">
        <h2 className="font-display text-lg text-ink">{editing ? "Edit skill" : "New skill"}</h2>
        {editing && stored.isLoading && <Spinner size={14} />}
      </div>

      <div className="mt-4 space-y-4">
        <div className="space-y-1.5">
          <Label htmlFor="skill-name">Name</Label>
          <Input
            id="skill-name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="deploy-service"
          />
          <p className="text-xs text-muted">
            The agent asks for a skill by this name. Use lowercase letters, numbers, and hyphens.
          </p>
        </div>

        <div className="space-y-1.5">
          <Label htmlFor="skill-description">Description</Label>
          <Input
            id="skill-description"
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder="How to deploy the service."
          />
          <p className="text-xs text-muted">
            Every turn carries this line. Write what the skill does and when to use it.
          </p>
        </div>

        <div className="space-y-1.5">
          <Label htmlFor="skill-content">Playbook</Label>
          <Textarea
            id="skill-content"
            value={content}
            onChange={(e) => setContent(e.target.value)}
            rows={14}
            className="font-mono text-xs"
            placeholder={"# Deploy\n\nRun `make deploy`.\n"}
          />
          <p className="text-xs text-muted">
            Markdown, with no frontmatter. The agent reads this text when it calls the skill.
          </p>
        </div>

        {error && <p className="text-sm text-danger-500">{errorText(error)}</p>}

        <div className="flex items-center justify-between gap-3">
          <div className="flex items-center gap-2">
            <Button onClick={submit} disabled={pending}>
              {editing ? "Save skill" : "Create skill"}
            </Button>
            <Button variant="ghost" onClick={onClose} disabled={pending}>
              Cancel
            </Button>
          </div>
          {editing && skillId && (
            <Button
              variant="danger"
              size="sm"
              disabled={pending}
              onClick={() => remove.mutate(skillId, { onSuccess: onClose })}
            >
              Delete
            </Button>
          )}
        </div>
      </div>
    </div>
  );
}
