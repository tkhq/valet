import { useState } from "react";
import { Button, Input, Spinner } from "~/components/primitives";
import {
  useApiKeys,
  useCreateApiKey,
  useCreateTeamApiKey,
  useRevokeApiKey,
  useRevokeTeamApiKey,
  useTeamApiKeys,
  type CreatedApiKey,
} from "~/api/api-keys";
import { useOrg, useTeams } from "~/api/settings";
import { formatDateOr } from "~/lib/format-when";
import { useCopyToClipboard } from "~/lib/use-copy";
import { useWorkspaceScope } from "~/lib/workspace-scope";
import { CreateScopeLine, workspaceName, useActiveWorkspace } from "~/components/workspace-clause";

export function ApiKeysSection() {
  const { teamId } = useWorkspaceScope();
  if (teamId) return <TeamApiKeysSection teamId={teamId} />;
  return <PersonalApiKeysSection />;
}

function PersonalApiKeysSection() {
  const keysQ = useApiKeys();
  const [created, setCreated] = useState<CreatedApiKey | null>(null);

  return (
    <div className="space-y-4">
      <CreatePersonalKeyRow onCreated={setCreated} />

      {created && <KeyRevealBlock name={created.name ?? "New key"} secret={created.key} onDismiss={() => setCreated(null)} />}

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
            <PersonalApiKeyRow
              key={key.id}
              apiKeyId={key.id}
              name={key.name}
              start={key.start}
              createdAt={key.createdAt}
              lastRequest={key.lastRequest}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function TeamApiKeysSection({ teamId }: { teamId: string }) {
  const keysQ = useTeamApiKeys(teamId);
  const createKey = useCreateTeamApiKey(teamId);
  const teamsQ = useTeams();
  const orgQ = useOrg();
  const ws = useActiveWorkspace();
  const [created, setCreated] = useState<{ name: string | null; key: string } | null>(null);

  const team = teamsQ.data?.teams.find((t) => t.id === teamId);
  const canMutate = team?.callerRole === "admin" || orgQ.data?.callerRole === "admin";
  const place = ws ? workspaceName(ws) : "this workspace";

  return (
    <div className="space-y-4">
      <CreateScopeLine what="API key" />
      {canMutate && (
        <CreateTeamKeyRow
          onCreate={(name, onSuccess) => {
            createKey.mutate(name, {
              onSuccess: (resp) => {
                onSuccess();
                setCreated({ name: resp.name, key: resp.key });
              },
            });
          }}
          pending={createKey.isPending}
          error={createKey.error}
        />
      )}

      {created && (
        <KeyRevealBlock
          name={created.name ?? "New key"}
          secret={created.key}
          onDismiss={() => setCreated(null)}
        />
      )}

      {keysQ.isLoading && (
        <div className="flex items-center gap-2 py-4 text-sm text-muted">
          <Spinner size={14} /> Loading…
        </div>
      )}
      {keysQ.error && <p className="py-4 text-sm text-danger-500">Failed to load API keys.</p>}

      {keysQ.data && keysQ.data.length === 0 && (
        <p className="py-4 text-sm text-muted">
          {canMutate
            ? `No API keys in ${place} yet. Create one to call the API as this team.`
            : `No API keys in ${place} yet. A team admin can create one.`}
        </p>
      )}

      {keysQ.data && keysQ.data.length > 0 && (
        <div className="divide-y divide-line border-t border-line">
          {keysQ.data.map((key) => (
            <TeamApiKeyRow
              key={key.id}
              teamId={teamId}
              apiKeyId={key.id}
              name={key.name}
              start={key.start}
              createdAt={key.createdAt}
              lastRequest={key.lastRequest}
              revokeDisabled={!canMutate}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function CreatePersonalKeyRow({ onCreated }: { onCreated: (created: CreatedApiKey) => void }) {
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

function CreateTeamKeyRow({
  onCreate,
  pending,
  error,
}: {
  onCreate: (name: string, onSuccess: () => void) => void;
  pending: boolean;
  error: Error | null;
}) {
  const [name, setName] = useState("");

  function submit() {
    const trimmed = name.trim();
    if (!trimmed) return;
    onCreate(trimmed, () => setName(""));
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
        <Button type="button" onClick={submit} disabled={!name.trim() || pending}>
          {pending ? "Creating…" : "Create"}
        </Button>
      </div>
      {error && <p className="text-xs text-danger-500">{error.message}</p>}
    </div>
  );
}

function KeyRevealBlock({
  name,
  secret,
  onDismiss,
}: {
  name: string;
  secret: string;
  onDismiss: () => void;
}) {
  const { copied, copy } = useCopyToClipboard();

  return (
    <div className="space-y-3 rounded-md border border-line bg-ink-wash p-4">
      <div className="space-y-1">
        <div className="text-sm font-medium text-ink">{name}</div>
        <p className="text-xs text-muted">This is the only time the full key is shown.</p>
      </div>
      <div className="flex items-center gap-2">
        <code className="min-w-0 flex-1 overflow-x-auto whitespace-nowrap rounded border border-line bg-[--bg] px-3 py-2 font-mono text-xs text-ink">
          {secret}
        </code>
        <Button type="button" variant="secondary" size="sm" onClick={() => void copy(secret)}>
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

function PersonalApiKeyRow({
  apiKeyId,
  name,
  start,
  createdAt,
  lastRequest,
}: {
  apiKeyId: string;
  name: string | null;
  start: string | null;
  createdAt: Date | number;
  lastRequest: Date | number | null;
}) {
  const revokeKey = useRevokeApiKey();
  return (
    <ApiKeyRow
      name={name}
      start={start}
      createdAt={createdAt}
      lastRequest={lastRequest}
      pending={revokeKey.isPending}
      onRevoke={(done) => revokeKey.mutate(apiKeyId, { onSuccess: done })}
    />
  );
}

function TeamApiKeyRow({
  teamId,
  apiKeyId,
  name,
  start,
  createdAt,
  lastRequest,
  revokeDisabled,
}: {
  teamId: string;
  apiKeyId: string;
  name: string | null;
  start: string | null;
  createdAt: Date | number;
  lastRequest: Date | number | null;
  revokeDisabled?: boolean;
}) {
  const revokeKey = useRevokeTeamApiKey(teamId);
  return (
    <ApiKeyRow
      name={name}
      start={start}
      createdAt={createdAt}
      lastRequest={lastRequest}
      revokeDisabled={revokeDisabled}
      pending={revokeKey.isPending}
      onRevoke={(done) => revokeKey.mutate(apiKeyId, { onSuccess: done })}
    />
  );
}

function ApiKeyRow({
  name,
  start,
  createdAt,
  lastRequest,
  onRevoke,
  pending,
  revokeDisabled,
}: {
  name: string | null;
  start: string | null;
  createdAt: Date | number;
  lastRequest: Date | number | null;
  onRevoke: (done: () => void) => void;
  pending: boolean;
  revokeDisabled?: boolean;
}) {
  const [confirming, setConfirming] = useState(false);

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
      {revokeDisabled ? null : confirming ? (
        <span className="flex shrink-0 items-center gap-2">
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={() => setConfirming(false)}
            disabled={pending}
          >
            Cancel
          </Button>
          <Button
            type="button"
            variant="danger"
            size="sm"
            disabled={pending}
            onClick={() => onRevoke(() => setConfirming(false))}
          >
            {pending ? "Revoking…" : "Confirm revoke"}
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
