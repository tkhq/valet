import { useState, type FormEvent } from "react";
import { Link } from "@tanstack/react-router";
import { useArtifactEditor, useArtifactVersions, useRequestArtifactEdit, useRestoreArtifact } from "~/api/artifacts";
import { AssistantPanel } from "~/components/session/assistant-panel";
import { BackLink, Badge, Button, Callout, Dialog, DialogContent, DialogFooter, ErrorRow, LoadingRow, Select, TabBar, Textarea, tabPanelId } from "~/components/primitives";
import { cn } from "~/lib/cn";
import { errorText } from "~/lib/error-text";
import { useThemeAttribute } from "~/lib/use-theme-attribute";
import { ArtifactFrame, type ArtifactSelection } from "./artifact-frame";

interface EditorSelection {
  baseVersion: number;
  fragment: { text: string; start?: number; end?: number; vdid?: string; kind?: "text" | "element" };
}

export function ArtifactEditor({ id }: { id: string }) {
  const theme = useThemeAttribute();
  const [historyVersion, setHistoryVersion] = useState<number>();
  const latest = useArtifactEditor(id);
  const historical = useArtifactEditor(id, historyVersion);
  const history = useArtifactVersions(id);
  const edit = useRequestArtifactEdit(id);
  const restore = useRestoreArtifact(id);
  const [pane, setPane] = useState<"artifact" | "conversation">("artifact");
  const [view, setView] = useState<"preview" | "source">("preview");
  const [picking, setPicking] = useState(false);
  const [selection, setSelection] = useState<EditorSelection | null>(null);
  const [instruction, setInstruction] = useState("");
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const [restoreTarget, setRestoreTarget] = useState<{ version: number; baseVersion: number } | null>(null);
  const [restoreError, setRestoreError] = useState("");
  const data = latest.data;
  const shownQuery = historyVersion === undefined ? latest : historical;
  const shown = shownQuery.data;

  if (!data) return <div className="min-w-0 flex-1 p-6">
    <BackLink to="/artifacts" search={{ page: undefined, pageOwner: undefined }}>Artifacts</BackLink>
    {latest.isPending ? <LoadingRow label="Loading artifact…" /> : <>
      <ErrorRow>Could not load this artifact. Try again or return to Artifacts.</ErrorRow>
      <Button variant="secondary" size="sm" onClick={() => void latest.refetch()}>Try again</Button>
    </>}
  </div>;

  const { artifact } = data;
  const hasConversation = !!data.sourceSessionId && !!data.sourceThreadId;
  const canEdit = data.canEdit && hasConversation && typeof data.content === "string";
  const isHistory = historyVersion !== undefined;
  const staleSelection = selection !== null && selection.baseVersion !== artifact.version;
  const busy = edit.isPending || restore.isPending;
  const shownTitle = history.data?.versions.find((revision) => revision.version === historyVersion)?.title ?? artifact.title;

  function select(fragment: EditorSelection["fragment"]) {
    if (!canEdit || isHistory || busy || !shown) return;
    if (!fragment.text.trim() && !(fragment.kind === "element" && fragment.vdid)) return;
    if (fragment.text.length > 8192) {
      setSelection(null);
      setError("This selection is too long. Select no more than 8,192 source characters and try again.");
      return;
    }
    setSelection({ baseVersion: shown.version, fragment });
    setPicking(false);
    setError("");
    setMessage("");
  }

  function selectPreview(fragment: ArtifactSelection) {
    select({ ...fragment, kind: "text" });
  }

  async function sendEdit(event: FormEvent) {
    event.preventDefault();
    if (!selection || !instruction.trim() || staleSelection || busy || !canEdit || isHistory || latest.isError) return;
    setError("");
    setMessage("");
    try {
      const result = await edit.mutateAsync({ baseVersion: selection.baseVersion, instruction: instruction.trim(), selection: selection.fragment });
      if (result.sent) {
        setSelection(null);
        setInstruction("");
        setMessage("Edit request sent to Valet. The preview updates when a new version is ready.");
      } else {
        setMessage("Edit request saved, but it was not delivered to Valet. Try again to send it.");
      }
    } catch (cause) {
      const detail = errorText(cause);
      setError(`${detail} Your selection and instruction are saved here. Try again or select the source text.`);
    }
  }

  async function confirmRestore() {
    if (!restoreTarget || restoreTarget.baseVersion !== artifact.version || busy || latest.isError) return;
    setRestoreError("");
    try {
      const result = await restore.mutateAsync(restoreTarget);
      setHistoryVersion(undefined);
      setRestoreTarget(null);
      setPicking(false);
      setMessage(`Version ${restoreTarget.version} restored as working version ${result.version}. The shared pin is unchanged.`);
    } catch (cause) {
      const detail = errorText(cause);
      setRestoreError(`${detail} Close this dialog and check the working version before trying again.`);
    }
  }

  return <div className="flex min-h-0 min-w-0 flex-1 flex-col">
    <header className="flex shrink-0 flex-wrap items-center gap-3 border-b border-line p-4">
      <div className="min-w-0 flex-1">
        <BackLink to="/artifacts" search={{ page: undefined, pageOwner: undefined }}>Artifacts</BackLink>
        <h1 className="mt-1 truncate text-lg font-semibold" title={artifact.title}>{artifact.title}</h1>
        <div className="mt-2 flex flex-wrap gap-2">
          <Badge>Working version {artifact.version}</Badge>
          <Badge>{artifact.sharedVersion === null ? "Shared: latest working version" : `Shared pin: version ${artifact.sharedVersion}`}</Badge>
        </div>
      </div>
      <Button asChild variant="secondary" size="sm"><Link to="/a/$token" params={{ token: artifact.token }}>Open reader</Link></Button>
    </header>
    {latest.isError && <Callout tone="warning" role="alert" className="m-4">
      <p>Could not refresh the working version. Try again before you send an edit.</p>
      <Button variant="secondary" size="sm" onClick={() => void latest.refetch()}>Try again</Button>
    </Callout>}
    {message && <Callout tone="neutral" role="status" className="m-4">{message}</Callout>}
    {hasConversation && <TabBar
      tabs={[{ id: "artifact", label: "Artifact" }, { id: "conversation", label: "Conversation" }]}
      active={pane} onSelect={setPane} label="Editor panes" className="shrink-0 px-4 lg:hidden"
    />}
    <div className="flex min-h-0 min-w-0 flex-1 flex-col lg:flex-row">
      {hasConversation && <section
        id={tabPanelId("Editor panes", "conversation")}
        aria-label="Artifact conversation"
        role="tabpanel" aria-labelledby={`${tabPanelId("Editor panes", "conversation")}-tab`}
        className={cn("min-h-0 min-w-0 flex-1 flex-col border-line lg:flex lg:w-2/5 lg:flex-none lg:border-r", pane === "conversation" ? "flex" : "hidden")}
      >
        <AssistantPanel title="Valet" sessionId={data.sourceSessionId} threadId={data.sourceThreadId}
          onRetry={() => void latest.refetch()} scopeNotice="This conversation works on the artifact. Select a fragment to request a bounded edit." />
      </section>}
      <section
        id={tabPanelId("Editor panes", "artifact")}
        aria-label="Artifact editor"
        role={hasConversation ? "tabpanel" : undefined} aria-labelledby={hasConversation ? `${tabPanelId("Editor panes", "artifact")}-tab` : undefined}
        className={cn("min-h-0 min-w-0 flex-1 flex-col overflow-y-auto lg:flex", pane === "artifact" || !hasConversation ? "flex" : "hidden")}
      >
        <div className="flex shrink-0 flex-wrap items-center justify-between gap-2 border-b border-line px-4">
          <TabBar tabs={[{ id: "preview", label: "Preview" }, { id: "source", label: "Source" }]} active={view} onSelect={setView} label="Artifact view" size="sm" className="shadow-none" />
          <div className="flex min-w-0 flex-wrap items-center gap-2 py-2">
            {canEdit && !isHistory && view === "preview" && <Button variant={picking ? "primary" : "secondary"} size="sm" disabled={busy} aria-pressed={picking} onClick={() => setPicking(!picking)}>{picking ? "Cancel pick" : "Pick element"}</Button>}
            <Select size="sm" className="min-w-0 max-w-full sm:max-w-64" aria-label="Revision history" value={historyVersion ?? "latest"} disabled={history.isPending || history.isError || busy}
              onChange={(event) => {
                const version = Number(event.target.value);
                setHistoryVersion(event.target.value === "latest" || !Number.isSafeInteger(version) ? undefined : version);
                setPicking(false);
              }}>
              <option value="latest">Latest working version</option>
              {history.data?.versions.filter((revision) => revision.version !== artifact.version).map((revision) => <option key={revision.version} value={revision.version}>Version {revision.version}: {revision.title}</option>)}
            </Select>
          </div>
        </div>
        {history.isError && <Callout tone="warning" role="alert" className="m-4">
          <p>Could not load revision history. Try again.</p>
          <Button variant="secondary" size="sm" onClick={() => void history.refetch()}>Retry history</Button>
        </Callout>}
        {isHistory && <div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-line p-3 text-sm">
          <span className="min-w-0 flex-1">Viewing version {historyVersion}. This snapshot is read-only.</span>
          <Button variant="ghost" size="sm" disabled={busy} onClick={() => setHistoryVersion(undefined)}>Back to latest</Button>
          <Button variant="secondary" size="sm" disabled={busy || !shown || shownQuery.isError || latest.isError} onClick={() => {
            setRestoreError("");
            setRestoreTarget({ version: historyVersion, baseVersion: artifact.version });
          }}>Restore version {historyVersion}</Button>
        </div>}
        {!shown ? <div className="p-4">{shownQuery.isPending ? <LoadingRow label="Loading revision…" /> : <>
          <ErrorRow>Could not load this revision. Try again or go back to the latest version.</ErrorRow>
          <Button variant="secondary" size="sm" onClick={() => void shownQuery.refetch()}>Retry revision</Button>
        </>}</div> : <div role="tabpanel" id={tabPanelId("Artifact view", view)} aria-labelledby={`${tabPanelId("Artifact view", view)}-tab`} className="flex min-h-48 min-w-0 flex-1 flex-col overflow-hidden">
          {view === "preview" ? <ArtifactFrame key={shown.version} title={shownTitle} rendered={shown.rendered} theme={theme} icon={shown.icon} description={shown.description}
            picking={picking && canEdit && !isHistory} onSelect={canEdit && !isHistory ? selectPreview : undefined}
            onPick={(pick) => select({ text: pick.text ?? pick.label, vdid: pick.vdid, kind: "element" })}
            className="min-h-48 w-full flex-1 border-0 bg-paper" /> : <Textarea
              aria-label="Artifact source" readOnly value={shown.content} className="min-h-48 flex-1 resize-none rounded-none border-0 font-mono"
              onSelect={(event) => {
                const { selectionStart: start, selectionEnd: end } = event.currentTarget;
                if (start !== end) select({ text: shown.content.slice(start, end), start, end });
              }} />}
        </div>}
        {canEdit && !isHistory ? <form onSubmit={(event) => void sendEdit(event)} className="flex shrink-0 flex-col gap-3 border-t border-line p-4">
          {staleSelection && <Callout tone="warning" role="alert">The working version changed after this selection. Select it again before you send an edit.</Callout>}
          {error && <Callout tone="danger" role="alert">{error}</Callout>}
          {selection ? <div className="flex min-w-0 items-start gap-2 text-sm">
            <blockquote className="line-clamp-2 min-w-0 flex-1 whitespace-pre-wrap border-l-2 border-moss pl-3 text-muted">{selection.fragment.text || `Selected element: ${selection.fragment.vdid}`}</blockquote>
            <Button variant="ghost" size="sm" disabled={busy} onClick={() => setSelection(null)}>Clear selection</Button>
          </div> : <p className="text-sm text-muted">Select preview text, pick an element, or select an exact source fragment.</p>}
          <label className="flex min-w-0 flex-col gap-2 text-sm font-medium">Edit selection with Valet
            <Textarea value={instruction} maxLength={4096} disabled={busy} onChange={(event) => setInstruction(event.target.value)} placeholder="Describe the change to this selection" rows={2} />
          </label>
          <div className="flex justify-end"><Button type="submit" size="sm" disabled={busy || !selection || !instruction.trim() || staleSelection || latest.isError}>{edit.isPending ? "Sending…" : "Send edit"}</Button></div>
        </form> : !canEdit && <Callout tone="neutral" className="m-4">Editing is unavailable for this artifact. Open the reader to view its shared version.</Callout>}
      </section>
    </div>
    <Dialog open={restoreTarget !== null} onOpenChange={(open) => { if (!open && !restore.isPending) setRestoreTarget(null); }}>
      <DialogContent title={`Restore version ${restoreTarget?.version ?? ""}?`} description="Restore appends a new working version. The shared pin and reader access stay unchanged.">
        {restoreTarget && restoreTarget.baseVersion !== artifact.version && <Callout tone="warning" role="alert">The working version changed. Close this dialog and select the revision again.</Callout>}
        {restoreError && <Callout tone="danger" role="alert">{restoreError}</Callout>}
        <DialogFooter>
          <Button variant="ghost" disabled={restore.isPending} onClick={() => setRestoreTarget(null)}>Cancel</Button>
          <Button disabled={busy || !restoreTarget || restoreTarget.baseVersion !== artifact.version || latest.isError} onClick={() => void confirmRestore()}>Confirm restore version {restoreTarget?.version}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  </div>;
}
