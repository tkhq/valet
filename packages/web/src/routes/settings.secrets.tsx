import { createFileRoute } from "@tanstack/react-router";
import { useState, type FormEvent } from "react";
import type { SecretSummary } from "@valet/api/wire";
import { Button, Input, Spinner, Textarea } from "~/components/primitives";
import { Section } from "~/components/settings/section";
import { useDeleteSecret, useSaveSecret, useSecrets } from "~/api/secrets";
import { errorText } from "~/lib/error-text";
import { formatDateOr } from "~/lib/format-when";
import { useCopyToClipboard } from "~/lib/use-copy";

/**
 * `/settings/secrets` — the caller's personal secrets in the deployment's
 * secret store. A saved value is never shown again. A session the caller
 * owns reads it with
 * `valet-secrets run --env NAME=secret://personal/<name> -- <command>`.
 */
export const Route = createFileRoute("/settings/secrets")({
  component: PersonalSecretsPage,
});

export function PersonalSecretsPage() {
  const secretsQ = useSecrets();
  const data = secretsQ.data;
  return (
    <Section
      title="Secrets"
      description="Development credentials for your own sessions. Only sessions you own can use them, and Valet never shows a saved value."
    >
      {secretsQ.isLoading && (
        <div className="flex items-center gap-2 py-4 text-sm text-muted">
          <Spinner size={14} /> Loading…
        </div>
      )}
      {secretsQ.error && <p role="alert" className="py-4 text-sm text-danger-500">{errorText(secretsQ.error)}</p>}
      {data && !data.enabled && (
        <p className="py-4 text-sm text-muted">
          The secret store is not set up on this Valet. An operator sets VALET_SECRET_STORE to turn it on.
        </p>
      )}
      {data?.enabled && (
        <div className="min-w-0 max-w-full space-y-4">
          <SaveSecretForm />
          {data.secrets.length === 0 ? (
            <p className="py-4 text-sm text-muted">No secrets yet. Save one above, then use its reference in a session.</p>
          ) : (
            <div className="divide-y divide-line border-t border-line">
              {data.secrets.map((secret) => (
                <SecretRow key={secret.name} secret={secret} />
              ))}
            </div>
          )}
          <p className="text-xs text-muted">
            In a session you own, run{" "}
            <code className="font-mono">valet-secrets run --env NAME=&lt;reference&gt; -- &lt;command&gt;</code>.
            {data.provider && ` Values are stored in ${data.provider}.`}
          </p>
        </div>
      )}
    </Section>
  );
}

function SaveSecretForm() {
  const [name, setName] = useState("");
  const [value, setValue] = useState("");
  const save = useSaveSecret();
  const trimmed = name.trim();
  const canSave = trimmed.length > 0 && value.length > 0 && !save.isPending;

  function submit(e: FormEvent) {
    e.preventDefault();
    if (!canSave) return;
    save.mutate(
      { name: trimmed, value },
      {
        onSuccess: () => {
          setName("");
          setValue("");
        },
      },
    );
  }

  return (
    <form className="flex flex-col gap-2" onSubmit={submit}>
      <Input
        value={name}
        onChange={(e) => setName(e.target.value)}
        placeholder="Name, for example granola/api-key"
        aria-label="Secret name"
        autoComplete="off"
        spellCheck={false}
      />
      <Textarea
        value={value}
        onChange={(e) => setValue(e.target.value)}
        placeholder="Value"
        aria-label="Secret value"
        autoComplete="off"
        spellCheck={false}
        rows={2}
        className="font-mono"
      />
      <div className="flex items-center justify-end gap-2">
        {save.error && <p role="alert" className="mr-auto text-sm text-danger-500">{errorText(save.error)}</p>}
        <Button type="submit" disabled={!canSave}>
          {save.isPending ? "Saving…" : "Save"}
        </Button>
      </div>
    </form>
  );
}

function SecretRow({ secret }: { secret: SecretSummary }) {
  const [confirming, setConfirming] = useState(false);
  const remove = useDeleteSecret();
  const { copied, copy } = useCopyToClipboard();

  return (
    <div className="py-3">
      <div className="flex items-center gap-3 sm:gap-4">
        <div className="min-w-0 flex-1">
          <div className="truncate text-sm font-medium text-ink">{secret.name}</div>
          <div className="truncate font-mono text-xs text-muted">{secret.reference}</div>
        </div>
        <div className="hidden shrink-0 text-xs text-muted sm:block">Saved {formatDateOr(secret.createdAt, "—")}</div>
        <Button type="button" variant="ghost" size="sm" className="shrink-0" onClick={() => void copy(secret.reference)}>
          {copied ? "Copied" : "Copy reference"}
        </Button>
        {confirming ? (
          <span className="flex shrink-0 items-center gap-2">
            <Button type="button" variant="ghost" size="sm" onClick={() => setConfirming(false)} disabled={remove.isPending}>
              Cancel
            </Button>
            <Button
              type="button"
              variant="danger"
              size="sm"
              disabled={remove.isPending}
              onClick={() => remove.mutate(secret.name, { onSuccess: () => setConfirming(false) })}
            >
              {remove.isPending ? "Deleting…" : "Confirm delete"}
            </Button>
          </span>
        ) : (
          <Button type="button" variant="ghost" size="sm" className="shrink-0" onClick={() => setConfirming(true)}>
            Delete
          </Button>
        )}
      </div>
      {remove.error && <p role="alert" className="mt-1 text-xs text-danger-500">{errorText(remove.error)}</p>}
    </div>
  );
}
