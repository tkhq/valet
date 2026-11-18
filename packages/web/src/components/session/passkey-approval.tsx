import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { WebauthnStamper } from "@turnkey/sdk-browser";
import type { DecisionGate, PresenceStepResponse } from "@valet/api/wire";
import { api } from "~/api/client";
import { invalidateDecisionState } from "~/api/queries";
import { Button, Spinner } from "~/components/primitives";
import { errorText } from "~/lib/error-text";
import { cn } from "~/lib/cn";

type PasskeyView = NonNullable<DecisionGate["presence"]>;

/** Stamps one Turnkey request body with the person's passkey. A seam for tests. */
export type StampWithPasskey = (body: string) => Promise<{ stampHeaderName: string; stampHeaderValue: string }>;

const stampWithPasskey: StampWithPasskey = (body) =>
  new WebauthnStamper({ rpId: window.location.hostname, userVerification: "required" }).stamp(body);

/**
 * The body of a passkey gate
 * (`docs/specs/2026-11-17-commit-signing-user-registered-keys-design.md`).
 * It shows what the passkey signs, then runs the steps: ask the api for the
 * next unsigned Turnkey request, stamp it with the passkey, post it back.
 * A commit-signing gate takes one step per commit. The api resolves the
 * gate after the last step.
 */
export function PasskeyApproval({
  sessionId,
  gate,
  view,
  inset,
  busy,
  onDone,
  onReject,
  stamp = stampWithPasskey,
}: {
  sessionId: string;
  gate: DecisionGate;
  view: PasskeyView;
  inset: string;
  busy: boolean;
  onDone: () => void;
  onReject: () => void;
  stamp?: StampWithPasskey;
}) {
  const qc = useQueryClient();
  const [running, setRunning] = useState(false);
  const [progress, setProgress] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const approveLabel = gate.actions.find((a) => a.id === "approve")?.label ?? "Approve with passkey";
  const disabled = busy || running;

  async function approve() {
    if (disabled) return;
    setRunning(true);
    setError(null);
    try {
      let step: PresenceStepResponse = await api.getPasskeyStep(sessionId, gate.id);
      while (!step.done) {
        setProgress(step.total > 1 ? step.label : null);
        const signed = await stamp(step.body);
        step = await api.postPasskeyStep(sessionId, gate.id, { body: step.body, ...signed });
      }
      void invalidateDecisionState(qc, sessionId);
      onDone();
    } catch (err) {
      setError(errorText(err, "The passkey did not sign. Try again."));
    } finally {
      setRunning(false);
      setProgress(null);
    }
  }

  return (
    <div className={cn(inset, "space-y-2 pb-3")}>
      {view.kind === "git_commits" && (
        <>
          <p className="text-xs text-muted">
            {view.repo} · <span className="font-mono">{view.branch}</span>
          </p>
          <ul className="space-y-2 text-xs">
            {view.commits.map((commit) => (
              <li key={commit.sha} className="min-w-0 space-y-0.5">
                <div className="flex min-w-0 gap-2">
                  <span className="shrink-0 font-mono text-muted">{commit.sha.slice(0, 7)}</span>
                  <span className="min-w-0 break-words text-ink">{commit.subject}</span>
                </div>
                <div className="flex flex-wrap items-center gap-x-2 text-muted">
                  <span>
                    {commit.filesTotal} {commit.filesTotal === 1 ? "file" : "files"}, +{commit.additions} −{commit.deletions}
                  </span>
                  {commit.url ? (
                    <a className="text-accent-600 underline" href={commit.url} target="_blank" rel="noreferrer">
                      Review on GitHub
                    </a>
                  ) : (
                    <span>Not pushed: these numbers come from the agent's sandbox.</span>
                  )}
                </div>
                {commit.files.length > 0 && (
                  <details className="text-muted">
                    <summary className="cursor-pointer">Files</summary>
                    <ul className="mt-1 space-y-0.5">
                      {commit.files.map((file) => (
                        <li key={file.path} className="flex min-w-0 gap-2">
                          <span className="min-w-0 break-all font-mono">{file.path}</span>
                          <span className="shrink-0">+{file.additions} −{file.deletions}</span>
                        </li>
                      ))}
                      {commit.filesTotal > commit.files.length && <li>and {commit.filesTotal - commit.files.length} more</li>}
                    </ul>
                  </details>
                )}
              </li>
            ))}
          </ul>
        </>
      )}
      <p className="text-xs text-muted">
        Turnkey checks your passkey. Valet cannot approve this without it.
      </p>
      {progress && <p className="text-xs text-ink" aria-live="polite">{progress}</p>}
      {error && <p role="alert" className="text-xs text-danger-text">{error}</p>}
      <div className="flex items-center justify-end gap-2">
        <Button type="button" variant="ghost" size="sm" onClick={onReject} disabled={disabled}>
          Reject
        </Button>
        <Button type="button" size="sm" onClick={() => void approve()} disabled={disabled}>
          {running ? <Spinner size={14} /> : approveLabel}
        </Button>
      </div>
    </div>
  );
}
