import { useEffect, useId, useRef, useState, type FormEvent } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { FileText, LayoutTemplate } from "lucide-react";
import { api, type OwnerFilter } from "~/api/client";
import { qkArtifacts } from "~/api/artifacts";
import { Button, Dialog, DialogContent, DialogFooter, Input, RadioCard } from "~/components/primitives";
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
  const templateLabelId = useId();
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
    <DialogContent title="Create artifact" hideClose={pending} className="max-w-lg gap-6 p-6"
      description={owner.ownerType === "team"
        ? "Team members can view this artifact. It starts with a new team conversation."
        : "People in your organization can view this artifact. It starts with a new personal conversation."}>
      <form className="grid min-w-0 gap-5" onSubmit={(event) => void create(event)} aria-busy={pending}>
        <div className="grid gap-2">
          <label htmlFor={titleId} className="text-sm font-medium">Artifact title</label>
          <Input id={titleId} value={title} required maxLength={200} disabled={pending}
            onChange={(event) => { titleTouched.current = true; setTitle(event.target.value); }} />
        </div>
        <div className="grid min-w-0 gap-2">
          <span id={templateLabelId} className="text-sm font-medium">Template</span>
          <div role="radiogroup" aria-labelledby={templateLabelId} className="grid min-w-0 gap-3 sm:grid-cols-2">
            {artifactTemplates.map((item) => <RadioCard key={item.id}
              title={item.label} description={item.description} selected={template?.id === item.id} disabled={pending}
              icon={item.id === "document" ? <FileText className="h-4 w-4" /> : <LayoutTemplate className="h-4 w-4" />}
              onSelect={() => { setTemplate(item); if (!titleTouched.current) setTitle(item.defaultTitle); }} />)}
          </div>
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
