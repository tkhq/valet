import { useState, type FormEvent } from "react";
import type { DecisionGate } from "@valet/api/wire";
import { Button, Input, Spinner } from "~/components/primitives";
import { saveSecretValue } from "~/api/secrets";
import { ApiError } from "~/api/api-error";
import { errorText } from "~/lib/error-text";
import { cn } from "~/lib/cn";

type SecretRequest = NonNullable<DecisionGate["secretRequest"]>;

/** The reference the card answers with; mirrors the api's `secretReference`. */
export function requestedReference(request: SecretRequest): string {
  return request.scope === "team" && request.teamId
    ? `secret://team/${request.teamId}/${request.name}`
    : `secret://personal/${request.name}`;
}

/**
 * The body of a `request_secret` card: what the agent asked for, where the
 * value is saved, and a masked field. Save seals the value in the browser
 * and stores it, then answers the gate with the reference only. The value
 * never enters the thread.
 */
export function SecretRequestForm({
  request,
  inset,
  busy,
  onAnswered,
  onDecline,
}: {
  request: SecretRequest;
  inset: string;
  busy: boolean;
  onAnswered: (reference: string) => Promise<void>;
  onDecline: () => void;
}) {
  const [value, setValue] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const where = request.scope === "team" ? "This team's secrets" : "Your personal secrets";
  const disabled = busy || saving;

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (disabled || value.length === 0) return;
    setSaving(true);
    setError(null);
    const target = request.scope === "team" && request.teamId ? { scope: "team" as const, teamId: request.teamId } : { scope: "personal" as const };
    try {
      await saveSecretValue(target, request.name, value, { replace: request.replace === true });
    } catch (err) {
      // Saved by an earlier attempt: answer with the reference anyway.
      if (!(err instanceof ApiError && err.status === 409)) {
        setError(errorText(err, "Could not save the value. Try again."));
        setSaving(false);
        return;
      }
    }
    setValue("");
    try {
      await onAnswered(requestedReference(request));
    } catch (err) {
      setError(errorText(err, "Saved, but the agent was not told. Try Save again."));
    } finally {
      setSaving(false);
    }
  }

  return (
    <form className={cn(inset, "space-y-2 pb-3")} onSubmit={(e) => void submit(e)}>
      <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1 text-xs">
        <dt className="text-muted">Name</dt>
        <dd className="min-w-0 break-all font-mono text-ink">{request.name}</dd>
        {request.sendsTo && (
          <>
            <dt className="text-muted">Sent to</dt>
            <dd className="min-w-0 break-all font-mono text-ink">{request.sendsTo}</dd>
          </>
        )}
        <dt className="text-muted">Saved to</dt>
        <dd className="text-ink">{where}{request.replace ? ", replacing the saved value" : ""}</dd>
      </dl>
      <Input
        type="password"
        value={value}
        onChange={(e) => setValue(e.target.value)}
        placeholder="Paste the value"
        aria-label={`Value for ${request.name}`}
        autoComplete="off"
        spellCheck={false}
        disabled={disabled}
        className="font-mono"
      />
      <p className="text-xs text-muted">Encrypted in your browser. The agent gets a reference, never the value.</p>
      {error && <p role="alert" className="text-xs text-danger-text">{error}</p>}
      <div className="flex items-center justify-end gap-2">
        <Button type="button" variant="ghost" size="sm" onClick={onDecline} disabled={disabled}>
          Decline
        </Button>
        <Button type="submit" size="sm" disabled={disabled || value.length === 0}>
          {saving ? <Spinner size={14} /> : "Save"}
        </Button>
      </div>
    </form>
  );
}
