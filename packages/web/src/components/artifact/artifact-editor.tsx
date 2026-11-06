import { useRef, useState } from "react";
import { Link } from "@tanstack/react-router";
import { ArrowLeft, Check, ChevronDown, Code2, Download, ExternalLink, FileText, MousePointer2, X } from "lucide-react";
import type { ArtifactAnchorRect } from "@valet/shared";
import { api, ApiError } from "~/api/client";
import { useArtifactEditor, useArtifactVersions, useRequestArtifactEdit, useRestoreArtifact } from "~/api/artifacts";
import { AssistantPanel } from "~/components/session/assistant-panel";
import type { ComposerContext } from "~/components/session/composer";
import { BackLink, Button, Callout, Dialog, DialogContent, DialogFooter, ErrorRow, LoadingRow, TabBar, Textarea, tabPanelId } from "~/components/primitives";
import { Popover, PopoverAnchor, PopoverContent, PopoverTrigger } from "~/components/primitives/popover";
import { artifactConversationPrompt } from "~/lib/artifact-conversation";
import { cn } from "~/lib/cn";
import { artifactDownloadName, downloadTextFile } from "~/lib/download";
import { errorText } from "~/lib/error-text";
import { useThemeAttribute } from "~/lib/use-theme-attribute";
import { ArtifactFrame, type ArtifactSelection } from "./artifact-frame";

interface EditorSelection {
  baseVersion: number;
  fragment: { text: string; start?: number; end?: number; vdid?: string; kind?: "text" | "element" };
  rect?: ArtifactAnchorRect;
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
  const [pendingSelection, setPendingSelection] = useState<EditorSelection | null>(null);
  const [selection, setSelection] = useState<EditorSelection | null>(null);
  const [focusKey, setFocusKey] = useState(0);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const [restoreTarget, setRestoreTarget] = useState<{ version: number; baseVersion: number } | null>(null);
  const [restoreError, setRestoreError] = useState("");
  const previewRef = useRef<HTMLDivElement>(null);
  const pendingRef = useRef(pendingSelection);
  pendingRef.current = pendingSelection;
  const selectionAnchor = useRef({
    getBoundingClientRect: () => {
      const bounds = previewRef.current?.getBoundingClientRect();
      if (!bounds) return new DOMRect();
      const rect = pendingRef.current?.rect;
      const left = Math.max(0, Math.min(rect?.left ?? 16, Math.max(0, bounds.width - 160)));
      const top = Math.max(8, Math.min(rect?.top ?? 16, Math.max(8, bounds.height - 48)));
      return new DOMRect(bounds.left + left, bounds.top + top, Math.max(0, Math.min(rect?.width ?? 0, bounds.width - left)), Math.max(0, Math.min(rect?.height ?? 0, bounds.height - top)));
    },
  });
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
  const canEdit = data.canEdit && hasConversation;
  const isHistory = historyVersion !== undefined;
  const staleSelection = selection !== null && selection.baseVersion !== artifact.version;
  const busy = edit.isPending || restore.isPending;
  const shownTitle = history.data?.versions.find(revision => revision.version === historyVersion)?.title ?? artifact.title;

  function select(fragment: EditorSelection["fragment"], rect?: ArtifactAnchorRect) {
    if (!canEdit || isHistory || busy || !shown) return;
    if (!fragment.text.trim() && !(fragment.kind === "element" && fragment.vdid)) return;
    if (fragment.text.length > 8192) {
      setPendingSelection(null);
      setError("This selection is too long. Select no more than 8,192 source characters and try again.");
      return;
    }
    setPendingSelection({ baseVersion: shown.version, fragment, rect });
    setPicking(false);
    setError("");
    setMessage("");
  }

  function selectPreview({ rect, ...fragment }: ArtifactSelection) {
    select({ ...fragment, kind: "text" }, rect);
  }

  function attachSelection() {
    if (!pendingSelection || pendingSelection.baseVersion !== artifact.version || latest.isError || isHistory || busy || !canEdit) return;
    setSelection(pendingSelection);
    setPendingSelection(null);
    setFocusKey(previous => previous + 1);
    setPane("conversation");
  }

  async function sendEdit(instruction: string): Promise<boolean> {
    if (!selection || !instruction.trim() || staleSelection || busy || !canEdit || isHistory || latest.isError) return false;
    setError("");
    try {
      const result = await edit.mutateAsync({ baseVersion: selection.baseVersion, instruction: instruction.trim(), selection: selection.fragment });
      if (!result.sent) {
        setError("Your edit was saved, but was not delivered to Valet. Try again to send it.");
        return false;
      }
      setSelection(null);
      setMessage("Edit sent to Valet");
      return true;
    } catch (cause) {
      setError(`${errorText(cause)} Your selection and message are saved. Try again or select the source text.`);
      return false;
    }
  }

  const context: ComposerContext | undefined = selection ? {
    focusKey: `${id}:${focusKey}`,
    placeholder: "Describe the change to this selection…",
    maxLength: 4096,
    disabled: staleSelection || isHistory || busy || latest.isError || !canEdit,
    onSubmit: sendEdit,
    content: <div className="border-b border-line px-3 py-2 text-xs">
      <div className="flex min-w-0 items-center gap-2">
        <FileText className="h-3.5 w-3.5 shrink-0 text-moss" aria-hidden />
        <div className="min-w-0 flex-1"><p className="font-medium text-ink">Selected in {artifact.title}</p><p className="truncate text-muted" title={selection.fragment.text}>{selection.fragment.text || "Selected element"}</p></div>
        <Button variant="ghost" size="icon" aria-label="Clear selection" onClick={() => { setSelection(null); setError(""); }}><X className="h-3.5 w-3.5" aria-hidden /></Button>
      </div>
      {staleSelection && <p role="alert" className="mt-2 text-danger-600">This selection is from an earlier version. Select it again before sending.</p>}
      {isHistory && <p role="alert" className="mt-2 text-muted">Return to the latest version to send this edit.</p>}
      {error && <p role="alert" className="mt-2 text-danger-600">{error}</p>}
    </div>,
  } : undefined;

  async function beforeSend(text: string) {
    if (isHistory) throw new ApiError(400, "Historical version is read-only.", { corrective: "Return to the latest version before requesting changes." });
    const current = await api.getArtifactEditor(id);
    if (!current.canEdit || !current.sourceThreadId || current.sourceSessionId !== data?.sourceSessionId || current.sourceThreadId !== data?.sourceThreadId) {
      throw new ApiError(409, "Artifact conversation changed.", { corrective: "Reload this artifact to open its current conversation before sending." });
    }
    return { text: artifactConversationPrompt(text, current), threadId: current.sourceThreadId };
  }

  async function confirmRestore() {
    if (!restoreTarget || restoreTarget.baseVersion !== artifact.version || busy || latest.isError) return;
    setRestoreError("");
    try {
      const result = await restore.mutateAsync(restoreTarget);
      setHistoryVersion(undefined);
      setRestoreTarget(null);
      setPicking(false);
      setPendingSelection(null);
      setMessage(`Version ${restoreTarget.version} restored as version ${result.version}`);
    } catch (cause) {
      setRestoreError(`${errorText(cause)} Close this dialog and check the latest version before trying again.`);
    }
  }

  function changeRevision(version?: number) {
    setHistoryVersion(version);
    setHistoryOpen(false);
    setPicking(false);
    setPendingSelection(null);
  }

  return <div className="flex min-h-0 min-w-0 flex-1 flex-col">
    {hasConversation && <TabBar tabs={[{ id: "conversation", label: "Conversation" }, { id: "artifact", label: "Artifact" }]}
      active={pane} onSelect={setPane} label="Editor panes" size="sm" className="shrink-0 px-4 lg:hidden" />}
    <div className="flex min-h-0 min-w-0 flex-1 flex-col lg:flex-row">
      {hasConversation && <section id={tabPanelId("Editor panes", "conversation")} aria-label="Artifact conversation"
        role="tabpanel" aria-labelledby={`${tabPanelId("Editor panes", "conversation")}-tab`}
        className={cn("min-h-0 min-w-0 flex-1 flex-col border-line lg:flex lg:w-80 lg:flex-none lg:border-r xl:w-96", pane === "conversation" ? "flex" : "hidden")}>
        <AssistantPanel title="Valet" sessionId={data.sourceSessionId} threadId={data.sourceThreadId} onRetry={() => void latest.refetch()}
          context={context} beforeSend={beforeSend} composerLayout="stacked"
          emptyState={<div className="m-auto max-w-xs px-6 py-12 text-center"><FileText className="mx-auto mb-3 h-6 w-6 text-muted" aria-hidden /><h2 className="text-sm font-medium">Make it yours</h2><p className="mt-2 text-sm text-muted">Ask Valet to refine this {artifact.format === "html" ? "page" : "document"}, or select a part to edit.</p></div>} />
      </section>}
      <section id={tabPanelId("Editor panes", "artifact")} aria-label="Artifact editor"
        role={hasConversation ? "tabpanel" : undefined} aria-labelledby={hasConversation ? `${tabPanelId("Editor panes", "artifact")}-tab` : undefined}
        className={cn("min-h-0 min-w-0 flex-1 flex-col lg:flex", pane === "artifact" || !hasConversation ? "flex" : "hidden")}>
        <header className="flex h-[--nav-height] shrink-0 items-center gap-2 border-b border-line px-4">
          <Button asChild variant="ghost" size="sm" className="w-8 shrink-0 px-0"><Link to="/artifacts" search={{ page: undefined, pageOwner: undefined }} aria-label="Back to artifacts"><ArrowLeft className="h-4 w-4" aria-hidden /></Link></Button>
          <h1 className="min-w-0 flex-1 truncate text-sm font-medium" title={shownTitle}>{shownTitle}</h1>
          <Button asChild variant="ghost" size="sm" className="shrink-0"><Link to="/a/$token" params={{ token: artifact.token }} aria-label="Open shared view" title="Open shared view"><ExternalLink className="h-4 w-4" aria-hidden /></Link></Button>
        </header>
        {latest.isError && <Callout tone="warning" role="alert" className="m-3"><p>Could not refresh this artifact. Try again before sending an edit.</p><Button variant="ghost" size="sm" onClick={() => void latest.refetch()}>Try again</Button></Callout>}
        {error && !selection && <Callout tone="danger" role="alert" className="m-3">{error}</Callout>}
        <div ref={previewRef} className="relative flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
          {!shown ? <div className="p-4">{shownQuery.isPending ? <LoadingRow label="Loading revision…" /> : <><ErrorRow>Could not load this revision. Try again or return to the latest version.</ErrorRow><Button variant="secondary" size="sm" onClick={() => void shownQuery.refetch()}>Retry revision</Button></>}</div>
            : view === "preview" ? <ArtifactFrame key={shown.version} title={shownTitle} rendered={shown.rendered} theme={theme} icon={shown.icon} description={shown.description}
              picking={picking && canEdit && !isHistory} onSelect={canEdit && !isHistory ? selectPreview : undefined}
              onPick={pick => select({ text: pick.text ?? pick.label, vdid: pick.vdid, kind: "element" }, pick.rect)} className="min-h-0 w-full flex-1 border-0 bg-paper" />
            : <Textarea aria-label="Artifact source" readOnly value={shown.content} className="min-h-0 flex-1 resize-none rounded-none border-0 p-4 font-mono text-xs" onSelect={event => {
              const { selectionStart: start, selectionEnd: end } = event.currentTarget;
              if (start !== end) select({ text: shown.content.slice(start, end), start, end });
            }} />}
          <Popover open={pendingSelection !== null && !isHistory} onOpenChange={open => { if (!open) setPendingSelection(null); }}>
            <PopoverAnchor virtualRef={selectionAnchor} />
            <PopoverContent side="top" align="start" className="w-auto p-1" onOpenAutoFocus={event => event.preventDefault()} onCloseAutoFocus={event => event.preventDefault()}>
              <Button size="sm" variant="ghost" disabled={busy || !canEdit || latest.isError || pendingSelection?.baseVersion !== artifact.version} onClick={attachSelection}>Edit with Valet</Button>
            </PopoverContent>
          </Popover>
        </div>
        {isHistory && <div className="flex shrink-0 flex-wrap items-center gap-2 border-t border-line px-4 py-2 text-xs"><span className="min-w-0 flex-1 text-muted">Viewing version {historyVersion}</span><Button variant="ghost" size="sm" disabled={busy} onClick={() => changeRevision()}>Back to latest</Button><Button variant="secondary" size="sm" disabled={busy || !shown || shownQuery.isError || latest.isError} onClick={() => { setRestoreError(""); setRestoreTarget({ version: historyVersion, baseVersion: artifact.version }); }}>Restore version {historyVersion}</Button></div>}
        <footer className="flex min-h-11 shrink-0 items-center gap-2 border-t border-line px-4">
          <Popover open={historyOpen} onOpenChange={setHistoryOpen}>
            <PopoverTrigger asChild><Button variant="ghost" size="sm" aria-label="Revision history"><span>Version {shown?.version ?? artifact.version}</span><ChevronDown className="h-3.5 w-3.5" aria-hidden /></Button></PopoverTrigger>
            <PopoverContent align="start" side="top" className="w-72 p-2">
              <p className="px-2 py-1 text-sm font-medium">Version history</p>
              <p className="mb-2 px-2 text-xs text-muted">{artifact.sharedVersion === null ? "Shared view follows the latest version." : `Shared view is pinned to version ${artifact.sharedVersion}.`}</p>
              {history.isPending ? <LoadingRow label="Loading versions…" /> : history.isError ? <><ErrorRow>Could not load versions. Try again.</ErrorRow><Button variant="ghost" size="sm" onClick={() => void history.refetch()}>Retry history</Button></> : <div className="max-h-64 overflow-y-auto">{history.data?.versions.map(revision => <button key={revision.version} type="button" aria-label={`View version ${revision.version}`} aria-pressed={(historyVersion ?? artifact.version) === revision.version} onClick={() => changeRevision(revision.version === artifact.version ? undefined : revision.version)} className="flex min-h-11 w-full items-center gap-2 rounded px-2 py-2 text-left text-sm hover:bg-ink-wash"><span className="min-w-0 flex-1 truncate">Version {revision.version}{revision.version === artifact.version ? " · Latest" : ""}</span>{(historyVersion ?? artifact.version) === revision.version && <Check className="h-4 w-4 text-moss" aria-hidden />}</button>)}</div>}
            </PopoverContent>
          </Popover>
          <p role="status" className="min-w-0 flex-1 truncate text-xs text-muted" title={message}>{picking ? "Select an element on the page" : message || (!canEdit ? "Read only" : "")}</p>
          {canEdit && !isHistory && view === "preview" && artifact.format === "html" && <Button variant="ghost" size="sm" aria-label="Select element" title={picking ? "Cancel element selection" : "Select an element to edit"} aria-pressed={picking} disabled={busy} onClick={() => { setPicking(!picking); setPendingSelection(null); }}><MousePointer2 className="h-4 w-4" aria-hidden /></Button>}
          <Button variant="ghost" size="sm" aria-label={view === "source" ? "View preview" : "View source"} title={view === "source" ? "View preview" : "View source"} aria-pressed={view === "source"} onClick={() => { setView(view === "source" ? "preview" : "source"); setPicking(false); setPendingSelection(null); }}><Code2 className="h-4 w-4" aria-hidden /></Button>
          <Button variant="ghost" size="sm" aria-label="Download artifact" title="Download artifact" disabled={!shown} onClick={() => { if (shown) downloadTextFile(artifactDownloadName(shownTitle, artifact.format === "html" ? "html" : "md"), shown.content, artifact.format === "html" ? "text/html" : "text/markdown"); }}><Download className="h-4 w-4" aria-hidden /></Button>
        </footer>
      </section>
    </div>
    <Dialog open={restoreTarget !== null} onOpenChange={open => { if (!open && !restore.isPending) setRestoreTarget(null); }}>
      <DialogContent title={`Restore version ${restoreTarget?.version ?? ""}?`} description="This creates a new version. Sharing and previous versions stay the same.">
        {restoreTarget && restoreTarget.baseVersion !== artifact.version && <Callout tone="warning" role="alert">The artifact changed. Close this dialog and select the version again.</Callout>}
        {restoreError && <Callout tone="danger" role="alert">{restoreError}</Callout>}
        <DialogFooter><Button variant="ghost" disabled={restore.isPending} onClick={() => setRestoreTarget(null)}>Cancel</Button><Button disabled={busy || !restoreTarget || restoreTarget.baseVersion !== artifact.version || latest.isError} onClick={() => void confirmRestore()}>Confirm restore version {restoreTarget?.version}</Button></DialogFooter>
      </DialogContent>
    </Dialog>
  </div>;
}
