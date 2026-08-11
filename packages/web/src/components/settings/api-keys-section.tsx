import { useState } from "react";
import { Button, Input, Spinner } from "~/components/primitives";
import { useApiKeys, useCreateApiKey, useRevokeApiKey, type CreatedApiKey } from "~/api/api-keys";
import { formatDateOr } from "~/lib/format-when";
import { useCopyToClipboard } from "~/lib/use-copy";

/**
 * You · API keys panel. Owns its own loading/error/empty states (mirrors
 * `TeamsPanel`), a create row, the one-time secret reveal (contained
 * element, same treatment as the `/integrations` `ConnectForm`), and the
 * key list. Copy: brief-verbatim empty state and reveal caption.
 */
export function ApiKeysSection() {
  const keysQ = useApiKeys();
  const [created, setCreated] = useState<CreatedApiKey | null>(null);

  return (
    <div className="space-y-4">
      <CreateApiKeyRow onCreated={setCreated} />

      {created && <KeyRevealBlock created={created} onDismiss={() => setCreated(null)} />}

      {keysQ.isLoading && (
        <div className="flex items-center gap-2 py-4 text-sm text-muted">
          <Spinner size={14} /> Loading…
        </div>
      )}
      {keysQ.error && <p className="py-4 text-sm text-danger-500">Failed to load API keys.</p>}

      {keysQ.data && keysQ.data.length === 0 && (
        <p className="py-4 text-sm text-muted">
          No API keys yet. Create one to call the API from scripts.
        </p>
      )}

      {keysQ.data && keysQ.data.length > 0 && (
        <div className="divide-y divide-line border-t border-line">
          {keysQ.data.map((key) => (
            <ApiKeyRow key={key.id} apiKeyId={key.id} name={key.name} start={key.start} createdAt={key.createdAt} lastRequest={key.lastRequest} />
          ))}
        </div>
      )}
    </div>
  );
}

function CreateApiKeyRow({ onCreated }: { onCreated: (created: CreatedApiKey) => void }) {
  const [name, setName] = useState("");
  const createKey = useCreateApiKey();

  function submit() {
    const trimmed = name.trim();
    if (!trimmed) return;
    createKey.mutate(trimmed, {
      onSuccess: (created) => {
        setName("");
        onCreated(created);
      },
    });
  }

  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex gap-2">
        <Input
          value={name}
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") submit();
          }}
          placeholder="e.g. CI pipeline"
          aria-label="Key name"
          className="flex-1"
        />
        <Button type="button" onClick={submit} disabled={!name.trim() || createKey.isPending}>
          {createKey.isPending ? "Creating…" : "Create"}
        </Button>
      </div>
      {createKey.error && <p className="text-xs text-danger-500">{createKey.error.message}</p>}
    </div>
  );
}

function KeyRevealBlock({
  created,
  onDismiss,
}: {
  created: CreatedApiKey;
  onDismiss: () => void;
}) {
  const { copied, copy } = useCopyToClipboard();

  return (
    <div className="space-y-3 rounded-md border border-line bg-ink-wash p-4">
      <div className="space-y-1">
        <div className="text-sm font-medium text-ink">{created.name ?? "New key"}</div>
        <p className="text-xs text-muted">This is the only time the full key is shown.</p>
      </div>
      <div className="flex items-center gap-2">
        <code className="min-w-0 flex-1 overflow-x-auto whitespace-nowrap rounded border border-line bg-[--bg] px-3 py-2 font-mono text-xs text-ink">
          {created.key}
        </code>
        <Button type="button" variant="secondary" size="sm" onClick={() => void copy(created.key)}>
          {copied ? "Copied" : "Copy"}
        </Button>
      </div>
      <div className="flex justify-end">
        <Button type="button" variant="ghost" size="sm" onClick={onDismiss}>
          Done
        </Button>
      </div>
    </div>
  );
}

function ApiKeyRow({
  apiKeyId,
  name,
  start,
  createdAt,
  lastRequest,
}: {
  apiKeyId: string;
  name: string | null;
  start: string | null;
  createdAt: Date;
  lastRequest: Date | null;
}) {
  const [confirming, setConfirming] = useState(false);
  const revokeKey = useRevokeApiKey();

  return (
    <div className="flex items-center gap-3 py-3 sm:gap-4">
      <div className="min-w-0 flex-1">
        <div className="truncate text-sm font-medium text-ink">{name ?? "Unnamed key"}</div>
        <div className="truncate font-mono text-xs text-muted">{start ?? "…"}</div>
      </div>
      <div className="hidden shrink-0 text-xs text-muted sm:block">
        Created {formatDateOr(createdAt, "—")}
      </div>
      <div className="hidden shrink-0 text-xs text-muted sm:block">
        Last used {formatDateOr(lastRequest, "Never")}
      </div>
      {confirming ? (
        <span className="flex shrink-0 items-center gap-2">
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={() => setConfirming(false)}
            disabled={revokeKey.isPending}
          >
            Cancel
          </Button>
          <Button
            type="button"
            variant="danger"
            size="sm"
            disabled={revokeKey.isPending}
            onClick={() => revokeKey.mutate(apiKeyId, { onSuccess: () => setConfirming(false) })}
          >
            {revokeKey.isPending ? "Revoking…" : "Confirm revoke"}
          </Button>
        </span>
      ) : (
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="shrink-0"
          onClick={() => setConfirming(true)}
        >
          Revoke
        </Button>
      )}
    </div>
  );
}
