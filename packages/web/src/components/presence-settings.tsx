import { useId } from "react";
import { type Presence, validatePresence } from "@valet/shared";
import { Input, Label } from "~/components/primitives";

export function PresenceSettings({ value, onChange, subscription = false, disabled = false }: {
  value: Presence;
  onChange: (value: Presence) => void;
  subscription?: boolean;
  disabled?: boolean;
}) {
  const id = useId();
  const error = validatePresence(value);
  function change(field: keyof Presence, text: string) {
    const next = { ...value };
    if (text.length === 0) delete next[field];
    else next[field] = text;
    onChange(next);
  }
  return (
    <fieldset disabled={disabled} className="grid gap-2">
      <legend className="mb-1 text-sm font-medium text-ink">Presence</legend>
      <p className="text-xs text-muted">
        {subscription
          ? "Leave fields empty to use the workflow or workspace identity. Subscription fields override workflow fields."
          : "Leave fields empty to use the workspace identity. Event subscriptions can override these fields."}
        {" "}Explicit identity arguments in tool calls take priority.
      </p>
      <Label htmlFor={`${id}-name`}>Display name</Label>
      <Input id={`${id}-name`} value={value.displayName ?? ""} maxLength={80}
        placeholder="Use inherited display name" onChange={(e) => change("displayName", e.target.value)} />
      <Label htmlFor={`${id}-avatar`}>Avatar URL</Label>
      <Input id={`${id}-avatar`} type="url" value={value.avatarUrl ?? ""} maxLength={2048}
        placeholder="https://example.com/avatar.png" aria-describedby={`${id}-help`}
        onChange={(e) => change("avatarUrl", e.target.value)} />
      <p id={`${id}-help`} className="text-xs text-muted">Use a public HTTPS image URL, including an avatar published from chat.</p>
      {error && <p role="alert" className="text-xs text-danger-500">{error}</p>}
    </fieldset>
  );
}
