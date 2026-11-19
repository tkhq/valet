import type { SecretUseRuleInput } from "@valet/api/wire";
import type { SecretUseDefault } from "@valet/shared";
import { Input, SelectMenu } from "~/components/primitives";

/**
 * The host and header fields that make a saved secret use-only: the use
 * service sends it only to that host, in that header, and the agent never
 * reads it. Settings, Secrets and the composer's paste prompt share these.
 */

export const HEADER_CHOICES = {
  bearer: { label: "Authorization: Bearer", header: "authorization", format: "Bearer {secret}" },
  apiKey: { label: "x-api-key", header: "x-api-key", format: "{secret}" },
  custom: { label: "Other header", header: "", format: "{secret}" },
} as const;
export type HeaderChoice = keyof typeof HEADER_CHOICES;

const OPTIONS = (Object.keys(HEADER_CHOICES) as HeaderChoice[]).map((value) => ({ value, label: HEADER_CHOICES[value].label }));

export interface SecretUseDraft {
  host: string;
  choice: HeaderChoice;
  customHeader: string;
}

/** The fields' starting values: a provider's usual host and header, or empty with Bearer. */
export function draftFromDefault(def: SecretUseDefault | undefined): SecretUseDraft {
  if (!def) return { host: "", choice: "bearer", customHeader: "" };
  const known = (Object.keys(HEADER_CHOICES) as HeaderChoice[]).find(
    (c) => c !== "custom" && HEADER_CHOICES[c].header === def.header && HEADER_CHOICES[c].format === def.format,
  );
  return known ? { host: def.host, choice: known, customHeader: "" } : { host: def.host, choice: "custom", customHeader: def.header };
}

/** A bare host from what the person typed: no scheme, no path. */
export function draftHost(draft: SecretUseDraft): string {
  return draft.host.trim().replace(/^https?:\/\//i, "").replace(/\/.*$/, "");
}

/** The use rule to save, or `undefined` when no host is set. A custom header with no name is not complete. */
export function ruleFromDraft(draft: SecretUseDraft): SecretUseRuleInput | undefined {
  const host = draftHost(draft);
  if (!host) return undefined;
  const header = draft.choice === "custom" ? draft.customHeader.trim().toLowerCase() : HEADER_CHOICES[draft.choice].header;
  if (!header) return undefined;
  return { hosts: [host], header, format: HEADER_CHOICES[draft.choice].format };
}

/** True when a host is set but the rule cannot be built yet (a custom header with no name). */
export function draftIncomplete(draft: SecretUseDraft): boolean {
  return draftHost(draft).length > 0 && ruleFromDraft(draft) === undefined;
}

export function SecretUseFields({
  draft,
  onChange,
  disabled,
  size = "md",
}: {
  draft: SecretUseDraft;
  onChange: (next: SecretUseDraft) => void;
  disabled?: boolean;
  size?: "sm" | "md";
}) {
  const host = draftHost(draft);
  return (
    <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
      <Input
        value={draft.host}
        onChange={(e) => onChange({ ...draft, host: e.target.value })}
        placeholder="Only for host, for example api.hetzner.cloud"
        aria-label="Only for host"
        size={size}
        autoComplete="off"
        spellCheck={false}
        disabled={disabled}
        className="min-w-0 flex-1 font-mono"
      />
      {host && (
        <SelectMenu
          value={draft.choice}
          options={OPTIONS}
          onChange={(choice) => onChange({ ...draft, choice })}
          ariaLabel="Header the secret goes in"
          disabled={disabled}
        />
      )}
      {host && draft.choice === "custom" && (
        <Input
          value={draft.customHeader}
          onChange={(e) => onChange({ ...draft, customHeader: e.target.value })}
          placeholder="Header name"
          aria-label="Header name"
          size={size}
          autoComplete="off"
          spellCheck={false}
          disabled={disabled}
          className="font-mono sm:w-40"
        />
      )}
    </div>
  );
}
