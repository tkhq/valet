import { useEffect, useId, useRef, useState, type FormEvent } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { api, type OwnerFilter } from "~/api/client";
import { qkArtifacts } from "~/api/artifacts";
import { Button, Dialog, DialogContent, DialogFooter, Input } from "~/components/primitives";
import { artifactTemplates, type ArtifactTemplate } from "~/lib/artifact-templates";

interface CreateArtifactDialogProps {
  open: boolean;
  owner: OwnerFilter;
  onOpenChange: (open: boolean) => void;
}

export function CreateArtifactDialog({ open, owner, onOpenChange }: CreateArtifactDialogProps) {
  return open ? <CreateArtifactForm key={`${owner.ownerType}:${owner.ownerId}`} owner={owner} onOpenChange={onOpenChange} /> : null;
}

function CreateArtifactForm({ owner, onOpenChange }: Omit<CreateArtifactDialogProps, "open">) {
  const firstTemplate = artifactTemplates[0];
  const [template, setTemplate] = useState<ArtifactTemplate | undefined>(firstTemplate);
  const [title, setTitle] = useState(firstTemplate?.defaultTitle ?? "");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string>();
  const titleTouched = useRef(false);
  const submitting = useRef(false);
  const attempt = useRef<{ key: string; source?: { sessionId: string; threadId: string } } | undefined>(undefined);
  const active = useRef(true);
  useEffect(() => { active.current = true; return () => { active.current = false; }; }, []);
  const titleId = useId();
  const radioName = useId();
  const navigate = useNavigate();
  const client = useQueryClient();

  const create = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const artifactTitle = title.trim();
    if (submitting.current || !template || !artifactTitle) return;
    submitting.current = true;
    setPending(true);
    setError(undefined);
    attempt.current ??= { key: `template-${crypto.randomUUID()}` };
    const current = attempt.current;
    try {
      if (!current.source) {
        if (owner.ownerType === "team") {
          const runtime = await api.ensureWorkspaceRuntime(owner.ownerId);
          const thread = await api.createThread(runtime.workspaceSessionId ?? runtime.sessionId, {});
          current.source = { sessionId: thread.sessionId, threadId: thread.id };
        } else {
          current.source = await api.ensureWorkspaceConversation("user", { fresh: true });
        }
      }
      if (!active.current) return;
      const artifact = await api.createArtifactFromTemplate({ key: current.key, ...template.build(artifactTitle) }, owner, current.source);
      if (!active.current) return;
      void client.invalidateQueries({ queryKey: qkArtifacts.list() });
      onOpenChange(false);
      void navigate({ to: "/artifacts/$id", params: { id: artifact.id } });
    } catch {
      if (active.current) {
        setError(current.source
          ? "Could not create the artifact. Try again to use the same conversation."
          : "Could not start the artifact conversation. Try again.");
      }
    } finally {
      submitting.current = false;
      if (active.current) setPending(false);
    }
  };

  return <Dialog open onOpenChange={(next) => { if (!pending) onOpenChange(next); }}>
    <DialogContent title="Create artifact" hideClose={pending}
      description={owner.ownerType === "team"
        ? "Team members can view this artifact. It starts with a new team conversation."
        : "People in your organization can view this artifact. It starts with a new personal conversation."}>
      <form className="grid min-w-0 gap-5" onSubmit={(event) => void create(event)} aria-busy={pending}>
        <fieldset className="grid min-w-0 gap-2" disabled={pending}>
          <legend className="mb-2 text-sm font-medium">Template</legend>
          {artifactTemplates.map((item) => <label key={item.id} className="flex cursor-pointer items-start gap-3 rounded-md border border-[--border] p-3 has-[:checked]:border-moss has-[:checked]:bg-moss-wash">
            <input type="radio" name={radioName} value={item.id} checked={template?.id === item.id} className="mt-1 accent-moss"
              onChange={() => { setTemplate(item); if (!titleTouched.current) setTitle(item.defaultTitle); }} />
            <span className="min-w-0"><span className="block text-sm font-medium">{item.label}</span><span className="block text-sm text-muted">{item.description}</span></span>
          </label>)}
        </fieldset>
        <div className="grid gap-2">
          <label htmlFor={titleId} className="text-sm font-medium">Artifact title</label>
          <Input id={titleId} value={title} required maxLength={200} disabled={pending}
            onChange={(event) => { titleTouched.current = true; setTitle(event.target.value); }} />
        </div>
        {error && <p role="alert" className="text-sm text-danger-600">{error}</p>}
        <DialogFooter>
          <Button variant="secondary" disabled={pending} onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button type="submit" disabled={pending || !title.trim() || !template}>{pending ? "Creating…" : error ? "Try again" : "Create artifact"}</Button>
        </DialogFooter>
      </form>
    </DialogContent>
  </Dialog>;
}
