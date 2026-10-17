/**
 * Import an existing workflow definition.
 *
 * Two sources, one path through the dialog: read the file, show what it
 * contains, then create it. The review step is the point — a definition is
 * machine-written JSON, and committing one unseen is how a workflow nobody
 * recognises ends up in the list.
 *
 * Nothing is created until the review step is confirmed, and a refusal
 * shows the validator's own messages, node by node. `POST /api/workflows`
 * validates again with the plugin catalog this deployment actually has, so
 * a definition naming a service that is not installed is refused there and
 * its message is shown here unaltered.
 *
 * The repository source reads PUBLIC repositories only — see the route's
 * comment in `packages/api/src/routes/workflows.ts` for why an org
 * credential must not sit behind a box that takes a repository name.
 */
import { useId, useRef, useState, type ChangeEvent } from "react";
import { useNavigate } from "@tanstack/react-router";
import { Upload } from "lucide-react";
import { api } from "~/api/client";
import { useCreateWorkflow } from "~/api/workflows";
import {
  Button,
  Dialog,
  DialogContent,
  DialogFooter,
  Input,
  Label,
  Spinner,
  TabBar,
  tabPanelId,
  Textarea,
} from "~/components/primitives";
import { ServiceIcon } from "~/components/service-icon";
import { displayName } from "~/components/integrations/display-name";
import { useWorkspaceScope } from "~/lib/workspace-scope";
import { errorMessages } from "~/lib/error-text";
import {
  MAX_IMPORT_BYTES,
  parseWorkflowImport,
  previewWorkflowImport,
  suggestedImportName,
  type ParsedWorkflowImport,
  type WorkflowImport,
} from "./import-workflow";

type ImportSource = "file" | "repo";

type Phase =
  | { kind: "idle" }
  | { kind: "busy"; label: string }
  | { kind: "confirm"; value: WorkflowImport; from: string }
  | { kind: "error"; messages: string[] };

const TABS = [
  { id: "file", label: "Paste or upload" },
  { id: "repo", label: "Repository" },
] as const;

const TABLIST_LABEL = "Import source";

export function ImportWorkflowDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (next: boolean) => void;
}) {
  const navigate = useNavigate();
  const create = useCreateWorkflow();
  const fieldId = useId();
  const fileInputRef = useRef<HTMLInputElement>(null);
  // The active workspace owns the import, exactly as it owns a workflow
  // created from a template. An Owner select here would ask again what the
  // nav's workspace switcher has already answered.
  const scope = useWorkspaceScope();

  const [source, setSource] = useState<ImportSource>("file");
  const [text, setText] = useState("");
  const [repo, setRepo] = useState("");
  const [path, setPath] = useState("");
  const [ref, setRef] = useState("");
  const [name, setName] = useState("");
  const [phase, setPhase] = useState<Phase>({ kind: "idle" });
  /**
   * Which open this dialog is on. Every async task below holds the count it
   * started under and writes no state once `close` has moved it on —
   * otherwise a read that lands after a cancel leaves the next open on a
   * review step for a file nobody chose.
   */
  const opened = useRef(0);

  /** Parsed text → the review step, or the parser's messages. `from` names
   * the origin on screen; `fileName` seeds the name field when the file
   * carried no name of its own.
   *
   * The parser returns a result for every input; the catch is here because
   * the callers start this with `void`, and a rejection would leave the
   * dialog on the step it was on with its button looking dead. */
  async function review(fileText: string, from: string, fileName?: string): Promise<void> {
    const open = opened.current;
    let parsed: ParsedWorkflowImport;
    try {
      parsed = await parseWorkflowImport(fileText, fileName);
    } catch (err) {
      if (opened.current !== open) return;
      const detail = err instanceof Error ? `: ${err.message}` : "";
      setPhase({
        kind: "error",
        messages: [
          `Valet could not read ${from}${detail}. Check that the file holds a workflow definition, then try again.`,
        ],
      });
      return;
    }
    if (opened.current !== open) return;
    if (!parsed.ok) {
      setPhase({ kind: "error", messages: parsed.errors });
      return;
    }
    setName(parsed.value.name ?? suggestedImportName(fileName));
    setPhase({ kind: "confirm", value: parsed.value, from });
  }

  function onPickFile(e: ChangeEvent<HTMLInputElement>): void {
    const open = opened.current;
    const file = e.target.files?.[0];
    e.target.value = ""; // so the same file can be chosen again after a fix
    if (!file) return;
    if (file.size > MAX_IMPORT_BYTES) {
      setPhase({
        kind: "error",
        messages: [
          `That file is ${Math.round(file.size / 1024 / 1024)} MB; the limit is ${MAX_IMPORT_BYTES / 1024 / 1024} MB. Choose a workflow definition, not an export of something else.`,
        ],
      });
      return;
    }
    void file.text().then(
      (fileText) => {
        if (opened.current !== open) return;
        setText(fileText);
        void review(fileText, file.name, file.name);
      },
      () => {
        if (opened.current !== open) return;
        setPhase({ kind: "error", messages: ["Could not read that file. Choose it again."] });
      },
    );
  }

  async function readFromRepo(): Promise<void> {
    const open = opened.current;
    setPhase({ kind: "busy", label: "Reading…" });
    try {
      const file = await api.getWorkflowImportFile({
        repo: repo.trim(),
        path: path.trim(),
        ...(ref.trim() === "" ? {} : { ref: ref.trim() }),
      });
      if (opened.current !== open) return;
      await review(file.content, `${file.repo}/${file.path}`, file.path);
    } catch (err) {
      if (opened.current !== open) return;
      setPhase({ kind: "error", messages: errorMessages(err) });
    }
  }

  async function commit(value: WorkflowImport): Promise<void> {
    const trimmed = name.trim();
    if (trimmed === "") return;
    setPhase({ kind: "busy", label: "Importing…" });
    try {
      const created = await create.mutateAsync({
        name: trimmed,
        definition: value.definition,
        ...(scope.teamId === undefined ? {} : { teamId: scope.teamId }),
      });
      close();
      void navigate({ to: "/workflows/$workflowId", params: { workflowId: created.id } });
    } catch (err) {
      // Nothing was created — the create route validates before it writes,
      // so a corrected file can be imported straight away.
      setPhase({ kind: "error", messages: errorMessages(err) });
    }
  }

  /** Closing clears the form. A half-typed repository address left over from
   * a failed read reads as the state of the NEXT import, which it is not.
   * The count moves on so a read still in flight writes nothing. */
  function close(): void {
    opened.current += 1;
    setPhase({ kind: "idle" });
    setText("");
    setRepo("");
    setPath("");
    setRef("");
    setName("");
    onOpenChange(false);
  }

  const busy = phase.kind === "busy";

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (next) onOpenChange(true);
        else close();
      }}
    >
      <DialogContent
        className="max-h-[85vh] max-w-lg overflow-y-auto"
        title="Import a workflow"
        description="Reads a definition you already have, shows what it contains, then creates it here."
      >
        {phase.kind === "confirm" ? (
          <ReviewStep
            value={phase.value}
            from={phase.from}
            name={name}
            onName={setName}
            id={fieldId}
          />
        ) : (
          <>
            <TabBar
              tabs={TABS}
              active={source}
              onSelect={(next) => {
                setSource(next);
                setPhase({ kind: "idle" });
              }}
              label={TABLIST_LABEL}
            />

            {source === "file" ? (
              <div
                id={tabPanelId(TABLIST_LABEL, "file")}
                role="tabpanel"
                aria-labelledby={`${tabPanelId(TABLIST_LABEL, "file")}-tab`}
                className="grid gap-2"
              >
                <Label htmlFor={`${fieldId}-text`}>Workflow YAML or JSON</Label>
                <Textarea
                  id={`${fieldId}-text`}
                  value={text}
                  onChange={(e) => setText(e.target.value)}
                  rows={8}
                  spellCheck={false}
                  placeholder={'valet: workflow/v1\nname: Nightly triage\ndefinition:\n  version: dag/v1\n  nodes: [...]\n  edges: [...]'}
                  className="font-mono text-xs"
                />
                <p className="text-xs text-muted">
                  Paste a workflow file, or choose one. YAML and JSON both work, and the
                  editor&apos;s JSON view shows the definition of any workflow you already have.
                </p>
                <div>
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => fileInputRef.current?.click()}
                    disabled={busy}
                  >
                    <Upload className="h-3.5 w-3.5" /> Choose a file
                  </Button>
                </div>
                <input
                  ref={fileInputRef}
                  type="file"
                  accept="application/json,.json,.yaml,.yml"
                  className="hidden"
                  aria-label="Workflow file"
                  onChange={onPickFile}
                />
              </div>
            ) : (
              <div
                id={tabPanelId(TABLIST_LABEL, "repo")}
                role="tabpanel"
                aria-labelledby={`${tabPanelId(TABLIST_LABEL, "repo")}-tab`}
                className="grid gap-3"
              >
                <div className="grid gap-1">
                  <Label htmlFor={`${fieldId}-repo`}>Repository</Label>
                  <Input
                    id={`${fieldId}-repo`}
                    value={repo}
                    onChange={(e) => setRepo(e.target.value)}
                    placeholder="owner/repo"
                  />
                </div>
                <div className="grid gap-1">
                  <Label htmlFor={`${fieldId}-path`}>Path</Label>
                  <Input
                    id={`${fieldId}-path`}
                    value={path}
                    onChange={(e) => setPath(e.target.value)}
                    placeholder="workflows/deploy.json"
                  />
                </div>
                <div className="grid gap-1">
                  <Label htmlFor={`${fieldId}-ref`}>Branch, tag or commit</Label>
                  <Input
                    id={`${fieldId}-ref`}
                    value={ref}
                    onChange={(e) => setRef(e.target.value)}
                    placeholder="the default branch"
                  />
                </div>
                <p className="text-xs text-muted">
                  Valet reads public repositories only, without a credential. To import from a
                  private repository, open the file on GitHub and paste it on the other tab.
                </p>
              </div>
            )}
          </>
        )}

        {phase.kind === "error" && (
          <ul role="alert" className="grid gap-1 rounded border border-danger-500/30 bg-danger-500/10 px-3 py-2">
            {phase.messages.map((message) => (
              <li key={message} className="text-xs leading-relaxed text-danger-600">
                {message}
              </li>
            ))}
          </ul>
        )}

        {phase.kind === "busy" && (
          <p className="flex items-center gap-1.5 text-xs text-muted">
            <Spinner size={12} /> {phase.label}
          </p>
        )}

        <DialogFooter>
          {phase.kind === "confirm" ? (
            <>
              <Button variant="ghost" onClick={() => setPhase({ kind: "idle" })}>
                Back
              </Button>
              <Button onClick={() => void commit(phase.value)} disabled={name.trim() === ""}>
                Import
              </Button>
            </>
          ) : (
            <>
              <Button variant="ghost" onClick={close} disabled={busy}>
                Cancel
              </Button>
              {source === "file" ? (
                <Button
                  onClick={() => void review(text, "pasted file")}
                  disabled={busy || text.trim() === ""}
                >
                  Review
                </Button>
              ) : (
                <Button
                  onClick={() => void readFromRepo()}
                  disabled={busy || repo.trim() === "" || path.trim() === ""}
                >
                  Read file
                </Button>
              )}
            </>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** What the file contains, and the name it will be saved under. */
function ReviewStep({
  value,
  from,
  name,
  onName,
  id,
}: {
  value: WorkflowImport;
  from: string;
  name: string;
  onName: (next: string) => void;
  id: string;
}) {
  const preview = previewWorkflowImport(value.definition);

  return (
    <div className="grid gap-3">
      <div className="grid gap-1">
        <Label htmlFor={`${id}-name`}>Name</Label>
        <Input id={`${id}-name`} value={name} onChange={(e) => onName(e.target.value)} autoFocus />
      </div>

      {value.skipped.length > 0 && (
        <p className="text-xs text-muted">
          The file also carries {value.skipped.join(", ")}. The import creates the workflow and its
          graph only. Arm a schedule or an event trigger in Triggers after it is created.
        </p>
      )}

      <div className="rounded border border-line bg-ink-wash px-3 py-2">
        <p className="text-xs text-ink">
          <span className="font-medium">{preview.nodeCount}</span> node
          {preview.nodeCount === 1 ? "" : "s"} from <span className="font-mono">{from}</span>
        </p>
        <ul className="mt-1.5 flex flex-wrap gap-1.5">
          {preview.nodeTypes.map((entry) => (
            <li
              key={entry.type}
              className="rounded-full bg-paper px-2 py-0.5 font-mono text-[11px] text-muted"
            >
              {entry.type} × {entry.count}
            </li>
          ))}
        </ul>
      </div>

      {preview.services.length > 0 && (
        <div className="grid gap-1.5">
          <p className="text-xs text-muted">This workflow calls:</p>
          <div className="flex flex-wrap items-center gap-3">
            {preview.services.map((service) => (
              <span key={service} className="flex items-center gap-1.5">
                <ServiceIcon slug={service} label={displayName(service)} size="sm" />
                <span className="text-xs text-muted">{displayName(service)}</span>
              </span>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
