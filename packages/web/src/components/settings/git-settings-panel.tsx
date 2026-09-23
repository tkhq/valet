import { useEffect, useMemo, useState } from "react";
import type { GitCommitMode, GitSettingsResponse, PatchGitSettingsRequest } from "@valet/api/wire";
import { useGitSettings, usePatchGitSettings } from "~/api/settings";
import { Button } from "~/components/primitives";
import { FieldRow } from "~/components/settings/field-row";
import { Section } from "~/components/settings/section";

export function controlsFromGitMode(mode: GitCommitMode) {
  return { identity: mode.startsWith("user_") ? "user" as const : "valet" as const, signed: mode === "user_turnkey_signed" || mode === "valet_app_signed" };
}
export function gitModeFromControls(identity: "user" | "valet", signed: boolean): GitCommitMode {
  return identity === "user" ? (signed ? "user_turnkey_signed" : "user_unsigned") : (signed ? "valet_app_signed" : "valet_unsigned");
}

export function gitSettingsPatch<K extends keyof GitSettingsResponse["values"]>(field: K, value: GitSettingsResponse["values"][K]): PatchGitSettingsRequest {
  return { [field]: value };
}

export function GitSettingsPanel({ scope, teamId }: { scope: "user" | "team" | "organization"; teamId?: string }) {
  const query = useGitSettings(scope, teamId); const mutation = usePatchGitSettings(scope, teamId);
  const [draft, setDraft] = useState<GitSettingsResponse["values"] | null>(null);
  const [patch, setPatch] = useState<PatchGitSettingsRequest>({});
  useEffect(() => { if (query.data) { setDraft(query.data.values); setPatch({}); } }, [query.data]);
  const controls = useMemo(() => draft ? controlsFromGitMode(draft.mode) : null, [draft]);
  if (query.isLoading || !query.data || !draft || !controls) return <p className="text-sm text-muted">Loading Git settings…</p>;
  const data = query.data;
  const signer = controls.identity === "user" ? data.capabilities.userTurnkeySigned : data.capabilities.valetAppSigned;
  const dirty = Object.keys(patch).length > 0;
  const change = <K extends keyof GitSettingsResponse["values"]>(field: K, value: GitSettingsResponse["values"][K]) => {
    setDraft({ ...draft, [field]: value });
    setPatch({ ...patch, ...gitSettingsPatch(field, value) });
  };
  const save = () => mutation.mutate(patch);
  const clear = (field: keyof PatchGitSettingsRequest) => mutation.mutate({ [field]: null });
  const source = (field: keyof GitSettingsResponse["values"]) => <p className="mt-1 text-xs text-muted">Source: {data.sources[field].label}</p>;
  return <Section title="Git commits" description="Choose commit identity, credit, correlation, and signing defaults.">
    <FieldRow label="Commit as" hint="Identity and signer are saved together as one valid mode.">
      <fieldset><legend className="sr-only">Commit as</legend><div className="flex gap-4">
        {(["user", "valet"] as const).map((identity) => <label key={identity} className="flex items-center gap-2 text-sm"><input type="radio" name="git-identity" checked={controls.identity === identity} onChange={() => { const capability = identity === "user" ? data.capabilities.userTurnkeySigned : data.capabilities.valetAppSigned; change("mode", gitModeFromControls(identity, controls.signed && capability.available)); }} />{identity === "user" ? "You" : "Valet"}</label>)}
      </div></fieldset>{source("mode")}{scope !== "organization" && data.overrides.mode !== undefined && <button className="mt-1 text-xs text-moss" onClick={() => clear("mode")}>Use organization default</button>}
    </FieldRow>
    <FieldRow label="Sign commits" hint={signer.available ? "GitHub creates App-signed Valet commits on the host." : signer.reason} error={!signer.available && controls.signed ? signer.reason : undefined}>
      <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={controls.signed} disabled={!signer.available && !controls.signed} aria-describedby="git-sign-help" onChange={(event) => change("mode", gitModeFromControls(controls.identity, event.target.checked))} />Sign commits</label>
      <p id="git-sign-help" className="sr-only">{signer.reason ?? "Signing is available."}</p>
    </FieldRow>
    <FieldRow label="Credit the counterpart" hint={controls.identity === "user" ? "Add Valet as a co-author." : "Add the acting user as a co-author."}>
      <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={draft.coAuthoredBy} onChange={(event) => change("coAuthoredBy", event.target.checked)} />Add co-author</label>{source("coAuthoredBy")}{scope !== "organization" && data.overrides.coAuthoredBy !== undefined && <button className="mt-1 text-xs text-moss" onClick={() => clear("coAuthoredBy")}>Use organization default</button>}
    </FieldRow>
    <FieldRow label="Correlation trailers" hint="Add opaque session and queue-item IDs. These values do not grant access.">
      <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={draft.correlationTrailers} onChange={(event) => change("correlationTrailers", event.target.checked)} />Add Valet correlation trailers</label>{source("correlationTrailers")}{scope !== "organization" && data.overrides.correlationTrailers !== undefined && <button className="mt-1 text-xs text-moss" onClick={() => clear("correlationTrailers")}>Use organization default</button>}
    </FieldRow>
    <div className="flex items-center justify-end gap-3 py-4"><span aria-live="polite" className="text-xs text-muted">{mutation.isPending ? "Saving…" : mutation.isSuccess ? "Saved." : ""}</span>{mutation.error && <span role="alert" className="text-xs text-danger-500">{mutation.error.message}</span>}<Button disabled={!dirty || mutation.isPending} onClick={save}>Save Git settings</Button></div>
  </Section>;
}
