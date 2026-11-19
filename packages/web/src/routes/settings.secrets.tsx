import { createFileRoute } from "@tanstack/react-router";
import { useId, useState, type FormEvent } from "react";
import type { SecretSummary } from "@valet/api/wire";
import { Button, Checkbox, EmptyRow, ErrorRow, Input, LoadingRow, TabBar, Textarea, tabPanelId, type TabDef } from "~/components/primitives";
import { Section } from "~/components/settings/section";
import { detectSecrets, secretUseDefaultFor } from "@valet/shared";
import { draftFromDefault, draftHost, ruleFromDraft, SecretUseFields, type SecretUseDraft } from "~/components/settings/secret-use-fields";
import { useRuleText, usesText } from "~/lib/secret-use";
import { useDeleteSecret, useSaveSecret, useSecrets, type SecretTarget } from "~/api/secrets";
import { useMe, useTeams } from "~/api/settings";
import { errorText } from "~/lib/error-text";
import { formatDateOr } from "~/lib/format-when";
import { useCopyToClipboard } from "~/lib/use-copy";

/**
 * `/settings/secrets` — secrets in the deployment's secret store, by scope:
 * the caller's own, each team they belong to, and the organization's. A saved
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
    { id: "company", label: "Organization" },
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
  const meQ = useMe();
  const data = secretsQ.data;
  if (secretsQ.isLoading) return <LoadingRow />;
  if (secretsQ.error) return <ErrorRow>{errorText(secretsQ.error)}</ErrorRow>;
  if (!data) return null;
  if (!data.enabled) {
    // Only an admin can act on the operator setting, so only an admin sees it.
    return (
      <EmptyRow>
        {meQ.data?.orgRole === "admin"
          ? "Secrets are not set up on this Valet. Set VALET_SECRET_STORE on the server to turn them on."
          : "Secrets are not set up on this Valet. Ask an admin to turn them on."}
      </EmptyRow>
    );
  }
  return (
    <div className="min-w-0 max-w-full space-y-4">
      <p className="text-xs text-muted">{SCOPE_TEXT[target.scope]}</p>
      {data.canWrite && <SaveSecretForm target={target} useAvailable={data.useAvailable} />}
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
        {data.useAvailable &&
          " A secret saved for one host is never given to a command: the agent calls that host with valet-secrets http, and only the response comes back."}
        {data.provider && ` Values are encrypted in your browser and stored in ${data.provider}.`}
      </p>
    </div>
  );
}

function SaveSecretForm({ target, useAvailable }: { target: SecretTarget; useAvailable: boolean }) {
  const [name, setName] = useState("");
  const [value, setValue] = useState("");
  const [useOnly, setUseOnly] = useState(false);
  const [draft, setDraft] = useState<SecretUseDraft>(() => draftFromDefault(undefined));
  // Set once the person edits the host or header: a pasted key then no longer
  // pre-fills them.
  const [ruleTouched, setRuleTouched] = useState(false);
  const useOnlyId = useId();
  const save = useSaveSecret(target);
  const trimmed = name.trim();
  const rule = ruleFromDraft(draft);
  const host = draftHost(draft);
  // A use-only secret needs a host: Valet never learns it from the first use.
  const canSave = trimmed.length > 0 && value.length > 0 && !save.isPending && (!useOnly || rule !== undefined);

  function changeValue(next: string) {
    setValue(next);
    if (ruleTouched) return;
    // A whole known key pre-fills where it goes; the person confirms by saving.
    const [match] = detectSecrets(next.trim());
    const def = match && match.confidence === "known" && match.value === next.trim() ? secretUseDefaultFor(match.label) : undefined;
    if (def) setDraft(draftFromDefault(def));
  }

  function submit(e: FormEvent) {
    e.preventDefault();
    if (!canSave) return;
    const use = useOnly ? rule : undefined;
    save.mutate(
      { name: trimmed, value, ...(use ? { use } : {}) },
      {
        onSuccess: () => {
          setName("");
          setValue("");
          setUseOnly(false);
          setDraft(draftFromDefault(undefined));
          setRuleTouched(false);
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
        onChange={(e) => changeValue(e.target.value)}
        placeholder="Value"
        aria-label="Secret value"
        autoComplete="off"
        spellCheck={false}
        rows={2}
        className="font-mono"
      />
      {useAvailable && (
        <div className="flex items-center gap-2">
          <Checkbox id={useOnlyId} checked={useOnly} onCheckedChange={setUseOnly} aria-label="Use only with one host" />
          <label htmlFor={useOnlyId} className="select-none text-sm text-ink">
            Use only with one host
          </label>
        </div>
      )}
      {useAvailable && useOnly && (
        <SecretUseFields
          draft={draft}
          onChange={(next) => {
            setDraft(next);
            setRuleTouched(true);
          }}
        />
      )}
      {useAvailable && (
        <p className="text-xs text-muted">
          {!useOnly
            ? "Commands in a session can read this value. Check Use only with one host to keep it from commands."
            : host
              ? `The agent never gets this value. Valet sends it only to ${host}, and only the response comes back.`
              : "Type the host the agent will call. The agent can call that host with this secret but can never read it."}
        </p>
      )}
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
  const [replacing, setReplacing] = useState(false);
  const [nextValue, setNextValue] = useState("");
  const remove = useDeleteSecret(target);
  const save = useSaveSecret(target);
  const { copied, copy } = useCopyToClipboard();

  function replace(e: FormEvent) {
    e.preventDefault();
    if (!nextValue || save.isPending) return;
    // A use-only secret keeps its rule: the rule is sealed with the value, so a
    // replace seals it again.
    save.mutate(
      { name: secret.name, value: nextValue, replace: true, ...(secret.use ? { use: secret.use } : {}) },
      {
        onSuccess: () => {
          setNextValue("");
          setReplacing(false);
        },
      },
    );
  }

  return (
    <div className="py-3">
      <div className="flex items-center gap-3 sm:gap-4">
        <div className="min-w-0 flex-1">
          <div className="truncate text-sm font-medium text-ink">{secret.name}</div>
          <div className="truncate font-mono text-xs text-muted">{secret.reference}</div>
          {secret.use && <div className="truncate text-xs text-muted">{useRuleText(secret.use)}</div>}
          {secret.uses && <div className="truncate text-xs text-muted">{usesText(secret.uses, (ms) => formatDateOr(ms, "—"))}</div>}
        </div>
        <div className="hidden shrink-0 text-xs text-muted sm:block">Saved {formatDateOr(secret.createdAt, "—")}</div>
        <Button type="button" variant="ghost" size="sm" className="shrink-0" onClick={() => void copy(secret.reference)}>
          {copied ? "Copied" : "Copy reference"}
        </Button>
        {canWrite && !confirming && !replacing && (
          <Button type="button" variant="ghost" size="sm" className="shrink-0" onClick={() => setReplacing(true)}>
            Replace
          </Button>
        )}
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
      {replacing && (
        <form className="mt-2 flex items-center gap-2" onSubmit={replace}>
          <Input
            type="password"
            value={nextValue}
            onChange={(e) => setNextValue(e.target.value)}
            placeholder="New value"
            aria-label={`New value for ${secret.name}`}
            autoComplete="off"
            spellCheck={false}
            size="sm"
            className="min-w-0 flex-1 font-mono"
          />
          <Button type="button" variant="ghost" size="sm" onClick={() => setReplacing(false)} disabled={save.isPending}>
            Cancel
          </Button>
          <Button type="submit" size="sm" disabled={!nextValue || save.isPending}>
            {save.isPending ? "Saving…" : "Save"}
          </Button>
        </form>
      )}
      {save.error && <p role="alert" className="mt-1 text-xs text-danger-500">{errorText(save.error)}</p>}
      {remove.error && <p role="alert" className="mt-1 text-xs text-danger-500">{errorText(remove.error)}</p>}
    </div>
  );
}
