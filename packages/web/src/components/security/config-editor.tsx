import { useEffect, useRef, useState } from "react";
import type { SecurityEngagementWire } from "@valet/api/wire";
import { Button, Input, Label } from "~/components/primitives";
import { useSetEngagementConfig, apiErrorText } from "~/api/security";

/**
 * The focus + invariants editor (dynamic-config M-F3, spec §Dynamic
 * configuration). Focus weights the review; a stated invariant turns a
 * confirmed violation into a high-signal finding. Both ride on every persona
 * dispatch (the engine injects them in `buildDispatchPrompt`).
 *
 * During planning an admin edits them and Saves; the server refuses a running
 * engagement, so once the review runs (or closes) the panel shows the active
 * focus + invariants READ-ONLY, so the user sees what the review was told.
 *
 * Mount-time-state rule: the draft seeds from the engagement's saved values and
 * resyncs when they change, UNLESS the admin has already edited it — a manual
 * edit must win over a background poll.
 */
export function ConfigEditor({
  sessionId,
  engagement,
  editable,
}: {
  sessionId: string;
  engagement: SecurityEngagementWire;
  /** True during planning for an admin; false once running/closed. */
  editable: boolean;
}) {
  const savedFocus = engagement.focus ?? "";
  const savedInvariants = engagement.invariants ?? [];

  if (!editable) {
    // Nothing to show when the review carried no focus + no invariants.
    if (savedFocus.trim() === "" && savedInvariants.length === 0) return null;
    return (
      <div className="border-b border-line px-4 py-3" data-testid="config-readonly">
        <h3 className="text-xs font-semibold text-ink">Review focus</h3>
        {savedFocus.trim() !== "" && (
          <p className="mt-1 text-[11px] text-muted" data-testid="config-readonly-focus">
            {savedFocus}
          </p>
        )}
        {savedInvariants.length > 0 && (
          <div className="mt-2">
            <span className="text-[11px] font-medium text-muted">Known invariants</span>
            <ul className="mt-1 list-disc pl-4 text-[11px] text-ink">
              {savedInvariants.map((inv, i) => (
                <li key={i}>{inv}</li>
              ))}
            </ul>
          </div>
        )}
      </div>
    );
  }

  return <ConfigEditorForm sessionId={sessionId} savedFocus={savedFocus} savedInvariants={savedInvariants} />;
}

function ConfigEditorForm({
  sessionId,
  savedFocus,
  savedInvariants,
}: {
  sessionId: string;
  savedFocus: string;
  savedInvariants: string[];
}) {
  const [focus, setFocus] = useState(savedFocus);
  const [invariants, setInvariants] = useState<string[]>(savedInvariants);
  const userTouched = useRef(false);
  const lastSignature = useRef(signature(savedFocus, savedInvariants));

  useEffect(() => {
    const sig = signature(savedFocus, savedInvariants);
    if (sig === lastSignature.current) return;
    lastSignature.current = sig;
    if (userTouched.current) return;
    setFocus(savedFocus);
    setInvariants(savedInvariants);
  }, [savedFocus, savedInvariants]);

  const save = useSetEngagementConfig(sessionId);

  function touchFocus(value: string) {
    userTouched.current = true;
    setFocus(value);
  }

  function touchInvariants(next: string[]) {
    userTouched.current = true;
    setInvariants(next);
  }

  function onSave() {
    userTouched.current = false;
    save.mutate({
      focus: focus.trim() === "" ? null : focus.trim(),
      invariants: invariants.map((inv) => inv.trim()).filter((inv) => inv !== ""),
    });
  }

  return (
    <div className="border-b border-line px-4 py-3" data-testid="config-editor">
      <h3 className="text-xs font-semibold text-ink">Review focus</h3>
      <p className="mt-1 text-[11px] text-muted">
        Focus the review and list invariants you already know. The review flags a
        broken invariant as a high-signal finding. Both freeze once it starts.
      </p>

      <div className="mt-3 grid gap-1">
        <Label htmlFor="config-focus">Focus (optional)</Label>
        <textarea
          id="config-focus"
          value={focus}
          onChange={(e) => touchFocus(e.target.value)}
          placeholder="e.g. the multi-tenant data path and the webhook verifier"
          className="min-h-[3rem] rounded border border-line bg-paper px-2 py-1 text-xs text-ink"
        />
      </div>

      <div className="mt-3 grid gap-1">
        <span className="text-xs text-muted">Known invariants (optional)</span>
        <div className="flex flex-col gap-2">
          {invariants.map((inv, index) => (
            <div key={index} className="flex items-center gap-2">
              <Input
                value={inv}
                onChange={(e) =>
                  touchInvariants(invariants.map((v, i) => (i === index ? e.target.value : v)))
                }
                placeholder="e.g. every admin route sits behind requireAdmin"
                className="h-8 flex-1 text-xs"
                aria-label={`Invariant ${index + 1}`}
              />
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={() => touchInvariants(invariants.filter((_, i) => i !== index))}
                aria-label={`Remove invariant ${index + 1}`}
              >
                Remove
              </Button>
            </div>
          ))}
        </div>
        <div>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={() => touchInvariants([...invariants, ""])}
          >
            Add invariant
          </Button>
        </div>
      </div>

      <div className="mt-3 flex items-center gap-2">
        <Button type="button" size="sm" onClick={onSave} disabled={save.isPending}>
          {save.isPending ? "Saving…" : "Save focus"}
        </Button>
        {save.isSuccess && !save.isPending && !userTouched.current && (
          <span className="text-[11px] text-moss" data-testid="config-saved">
            Saved
          </span>
        )}
      </div>

      {save.isError && (
        <p className="mt-2 text-[11px] text-danger-600" data-testid="config-save-error">
          {apiErrorText(save.error)}
        </p>
      )}
    </div>
  );
}

/** A stable signature of the saved config, so the resync effect fires only on a
 * real change, not on every poll's fresh array identity. */
function signature(focus: string, invariants: string[]): string {
  return JSON.stringify([focus, invariants]);
}
