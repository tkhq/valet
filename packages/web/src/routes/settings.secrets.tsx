import { createFileRoute } from "@tanstack/react-router";
import { useId, useState, type FormEvent } from "react";
import type { SecretSummary } from "@valet/api/wire";
import { Button, Input, Spinner, TabBar, Textarea, tabPanelId, type TabDef } from "~/components/primitives";
import { Section } from "~/components/settings/section";
import { useDeleteSecret, useSaveSecret, useSecrets, type SecretTarget } from "~/api/secrets";
import { useTeams } from "~/api/settings";
import { errorText } from "~/lib/error-text";
import { formatDateOr } from "~/lib/format-when";
import { useCopyToClipboard } from "~/lib/use-copy";

/**
 * `/settings/secrets` — secrets in the deployment's secret store, by scope:
 * the caller's own, each team they belong to, and the company's. A saved
 * value is never shown again. A session reads one with
 * `valet-secrets run --env NAME=<reference> -- <command>`.
 */
export const Route = createFileRoute("/settings/secrets")({
  component: SecretsPage,
});

const SCOPE_TEXT = {
  personal: "Only sessions you own personally can use these.",
  team: "This team's sessions, and your own sessions, can use these. Team members can change them.",
  company: "Every session in the organization can use these. Organization admins can change them.",
} as const;

export function SecretsPage() {
  const teamsQ = useTeams();
  const myTeams = (teamsQ.data?.teams ?? []).filter((t) => t.callerRole !== null);
  const tabs: TabDef<string>[] = [
    { id: "personal", label: "Personal" },
    ...myTeams.map((t) => ({ id: `team:${t.id}`, label: t.name })),
    { id: "company", label: "Company" },
  ];
  const [active, setActive] = useState("personal");
  const label = useId();
  const target: SecretTarget = active.startsWith("team:")
    ? { scope: "team", teamId: active.slice("team:".length) }
    : { scope: active === "company" ? "company" : "personal" };

  return (
    <Section title="Secrets" description="Credentials sessions can use without the value ever appearing in a thread. Valet never shows a saved value.">
      <TabBar tabs={tabs} active={active} onSelect={setActive} label="Secret scope" id={label} size="sm" />
      <div role="tabpanel" id={tabPanelId(label, active)} className="pt-3">
        <ScopePanel key={active} target={target} />
      </div>
    </Section>
  );
}

function ScopePanel({ target }: { target: SecretTarget }) {
  const secretsQ = useSecrets(target);
  const data = secretsQ.data;
  if (secretsQ.isLoading) {
    return (
      <div className="flex items-center gap-2 py-4 text-sm text-muted">
        <Spinner size={14} /> Loading…
      </div>
    );
  }
  if (secretsQ.error) return <p role="alert" className="py-4 text-sm text-danger-500">{errorText(secretsQ.error)}</p>;
  if (!data) return null;
  if (!data.enabled) {
    return (
      <p className="py-4 text-sm text-muted">
        The secret store is not set up on this Valet. An operator sets VALET_SECRET_STORE to turn it on.
      </p>
    );
  }
  return (
    <div className="min-w-0 max-w-full space-y-4">
      <p className="text-xs text-muted">{SCOPE_TEXT[target.scope]}</p>
      {data.canWrite && <SaveSecretForm target={target} />}
      {data.secrets.length === 0 ? (
        <p className="py-4 text-sm text-muted">
          {data.canWrite ? "No secrets yet. Save one above, then use its reference in a session." : "No secrets here yet."}
        </p>
      ) : (
        <div className="divide-y divide-line border-t border-line">
          {data.secrets.map((secret) => (
            <SecretRow key={secret.name} secret={secret} target={target} canWrite={data.canWrite} />
          ))}
        </div>
      )}
      <p className="text-xs text-muted">
        In a session, run <code className="font-mono">valet-secrets run --env NAME=&lt;reference&gt; -- &lt;command&gt;</code>.
        {data.provider && ` Values are encrypted in your browser and stored in ${data.provider}.`}
      </p>
    </div>
  );
}

function SaveSecretForm({ target }: { target: SecretTarget }) {
  const [name, setName] = useState("");
  const [value, setValue] = useState("");
  const save = useSaveSecret(target);
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
        placeholder="Name, for example OPENAI_API_KEY"
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

function SecretRow({ secret, target, canWrite }: { secret: SecretSummary; target: SecretTarget; canWrite: boolean }) {
  const [confirming, setConfirming] = useState(false);
  const remove = useDeleteSecret(target);
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
        {canWrite &&
          (confirming ? (
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
          ))}
      </div>
      {remove.error && <p role="alert" className="mt-1 text-xs text-danger-500">{errorText(remove.error)}</p>}
    </div>
  );
}
