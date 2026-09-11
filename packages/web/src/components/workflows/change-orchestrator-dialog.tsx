import { useEffect, useRef, useState } from "react";
import type { WorkflowDefinition } from "@valet/workflow";
import { useAssistants } from "~/api/assistants";
import { Button, Dialog, DialogContent, DialogFooter, Label } from "~/components/primitives";
import { assistantLabel } from "~/lib/assistant-name";
import { errorText } from "~/lib/error-text";

export function ChangeOrchestratorDialog({ definition, ownerType, ownerId, save, close }: {
  definition: WorkflowDefinition;
  ownerType: string;
  ownerId: string;
  save: (definition: WorkflowDefinition) => Promise<void>;
  close: () => void;
}) {
  const assistants = useAssistants();
  const choices = (assistants.data?.assistants ?? []).filter((a) => a.owner.type === ownerType && a.owner.id === ownerId);
  const [selected, setSelected] = useState(definition.assistantId ?? "");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string>();
  const generation = useRef(0);
  useEffect(() => () => { generation.current += 1; }, []);
  const valid = choices.some((a) => a.id === selected);
  async function submit() {
    if (!valid || pending || assistants.isPending || assistants.error) return;
    const request = generation.current;
    setPending(true);
    setError(undefined);
    try {
      await save({ ...definition, assistantId: selected });
      if (generation.current === request) close();
    } catch (err) {
      if (generation.current === request) setError(errorText(err));
    } finally {
      if (generation.current === request) setPending(false);
    }
  }
  return <Dialog open onOpenChange={(open) => { if (!open) close(); }}>
    <DialogContent title="Change orchestrator" description="Choose who handles this workflow’s editor conversation and future orchestrator steps. Running workflows keep their original target.">
      <Label htmlFor="saved-workflow-orchestrator">Orchestrator</Label>
      <select id="saved-workflow-orchestrator" className="w-full rounded border border-line bg-paper p-2" value={valid ? selected : ""} disabled={pending || assistants.isPending} onChange={(event) => setSelected(event.target.value)}>
        <option value="" disabled>Choose an orchestrator</option>
        {choices.map((a) => <option key={a.id} value={a.id}>{assistantLabel(a)}{a.isDefault ? " (default)" : ""}</option>)}
      </select>
      {assistants.error && <p role="alert">Could not load orchestrators. <button onClick={() => void assistants.refetch()}>Retry</button></p>}
      {!assistants.isPending && !assistants.error && !valid && <p role="status">Choose an available orchestrator from this workflow’s workspace.</p>}
      {error && <p role="alert">{error}</p>}
      <DialogFooter><Button variant="secondary" onClick={close}>Cancel</Button><Button disabled={!valid || pending || assistants.isPending || !!assistants.error} onClick={() => void submit()}>{pending ? "Saving…" : "Save orchestrator"}</Button></DialogFooter>
    </DialogContent>
  </Dialog>;
}
