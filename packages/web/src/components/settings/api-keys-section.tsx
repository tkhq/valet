import { useState } from "react";
import type { OrgDirectoryUserWire, TeamApiKeySummary } from "@valet/api/wire";
import {
  apiKeyLifetimeChoices,
  defaultApiKeyLifetime,
  SECONDS_PER_DAY,
  type ApiKeyLifetimeDays,
} from "@valet/shared";
import { Button, ErrorRow, Input, LoadingRow, ManagedNote, Select, type AppPath } from "~/components/primitives";
import {
  useApiKeys,
  useCreateApiKey,
  useCreateTeamApiKey,
  useRevokeApiKey,
  useRevokeTeamApiKey,
  useTeamApiKeys,
  type CreateApiKeyInput,
  type CreatedApiKey,
} from "~/api/api-keys";
import { useOrg, useOrgDirectory, useTeams } from "~/api/settings";
import { formatDate, formatDateOr } from "~/lib/format-when";
import { errorText } from "~/lib/error-text";
import { useCopyToClipboard } from "~/lib/use-copy";
import { useWorkspaceScope } from "~/lib/workspace-scope";
import { workspaceName, useActiveWorkspace } from "~/components/workspace-clause";

export function ApiKeysSection() {
  const { teamId } = useWorkspaceScope();
  if (teamId) return <TeamApiKeysSection key={teamId} teamId={teamId} />;
  return <PersonalApiKeysSection />;
}

function PersonalApiKeysSection() {
  const keysQ = useApiKeys();
  const orgQ = useOrg();
  const createKey = useCreateApiKey();
  const [created, setCreated] = useState<CreatedApiKey | null>(null);
  // Until the org loads, the form offers every choice. The api enforces the
  // policy whatever the form sends.
  const keysAllowed = orgQ.data?.allowPersonalApiKeys ?? true;

  return (
    <div className="min-w-0 max-w-full space-y-4">
      <CreateKeyRow
        maxLifetimeDays={orgQ.data?.maxApiKeyLifetimeDays ?? null}
        locked={!keysAllowed}
        changeAt={orgQ.data?.callerRole === "admin" ? "/settings/organization/policies" : undefined}
        onCreate={(input, onSuccess) => {
          createKey.mutate(input, {
            onSuccess: (resp) => {
              onSuccess();
              setCreated(resp);
            },
          });
        }}
        pending={createKey.isPending}
        errorMessage={createKey.error?.message ?? null}
      />

      {created && <KeyRevealBlock name={created.name ?? "New key"} secret={created.key} onDismiss={() => setCreated(null)} />}

      {keysQ.isLoading && <LoadingRow />}
      {keysQ.error && <ErrorRow>Failed to load API keys. Reload the page to try again.</ErrorRow>}

      {keysQ.data && keysQ.data.length === 0 && (
        <p className="py-4 text-sm text-muted">
          {keysAllowed ? "No API keys yet. Create one to call the API from scripts." : "No API keys yet."}
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
              expiresAt={key.expiresAt}
            />
          ))}
        </div>
      )}
    </div>
  );
}

/**
 * Who minted a team key, as a line for the row. Every member of the team
 * sees the key, so the row has to answer it; a personal key has one
 * possible creator and passes no label at all.
 *
 * `createdBy` on the wire is a user id. The org directory turns it into a
 * name, the same read the teams page uses for its roster
 * (`useOrgDirectory()`, member-visible). While that directory is still in
 * flight the row says nothing: a creator named wrong for one frame is
 * worse than a creator named one frame late.
 */
function creatorLabel(
  createdBy: string | null,
  directory: OrgDirectoryUserWire[] | undefined,
): string | null {
  if (!createdBy) return "Creator not recorded";
  if (!directory) return null;
  const identity = directory.find((u) => u.userId === createdBy);
  if (!identity) return "Created by a member who left the organization";
  return `Created by ${identity.name || identity.email}`;
}

export function TeamApiKeysSection({ teamId }: { teamId: string }) {
  const keysQ = useTeamApiKeys(teamId);
  const teamsQ = useTeams();
  const orgQ = useOrg();
  // Errors can coexist with cached admin roles and keys after a failed refetch.
  // Unmount the controls so secrets, drafts, and late callbacks lose their state.
  if (keysQ.error || teamsQ.error || orgQ.error) {
    return <ErrorRow>Could not verify team key access. Reload this page to try again.</ErrorRow>;
  }
  if (!keysQ.data || !teamsQ.data || !orgQ.data) {
    return <LoadingRow label="Loading team API keys…" />;
  }
  const team = teamsQ.data.teams.find((candidate) => candidate.id === teamId);
  if (!team) {
    return <ErrorRow>You are not a member of this team. Choose a team under Your teams.</ErrorRow>;
  }
  const canMutate = team.callerRole === "admin" || orgQ.data.callerRole === "admin";
  return (
    <TeamApiKeyControls
      key={`${teamId}:${canMutate}`}
      teamId={teamId}
      keys={keysQ.data}
      canMutate={canMutate}
      maxLifetimeDays={orgQ.data.maxApiKeyLifetimeDays ?? null}
    />
  );
}

function TeamApiKeyControls({ teamId, keys, canMutate, maxLifetimeDays }: {
  teamId: string;
  keys: TeamApiKeySummary[];
  canMutate: boolean;
  maxLifetimeDays: number | null;
}) {
  const createKey = useCreateTeamApiKey(teamId);
  const directoryQ = useOrgDirectory();
  const ws = useActiveWorkspace();
  const [created, setCreated] = useState<{ name: string | null; key: string } | null>(null);
  const place = ws ? workspaceName(ws) : "this workspace";

  return (
    <div className="min-w-0 max-w-full space-y-4">
      <div className="space-y-2 text-sm leading-relaxed text-muted">
        <p>Team members can see key names. Only team or organization admins can create or revoke keys.</p>
        <p>Secrets are shown once. Share only with intended users.</p>
        <details>
          <summary className="cursor-pointer font-medium text-ink">Key access and lifetime</summary>
          <ul className="mt-2 list-disc space-y-2 pl-5">
            <li>Keys can read, run, and change this team's runtimes and workflows, and delete runtimes.</li>
            <li>Workflow deletion requires a person with team or organization admin access. Keys cannot manage organization settings or other teams.</li>
            <li>Keys remain valid after their creator leaves. Revoke a key to stop access.</li>
          </ul>
        </details>
      </div>
      {canMutate && (
        <CreateKeyRow
          maxLifetimeDays={maxLifetimeDays}
          onCreate={(input, onSuccess) => {
            createKey.mutate(input, {
              onSuccess: (resp) => {
                onSuccess();
                setCreated({ name: resp.name, key: resp.key });
              },
            });
          }}
          pending={createKey.isPending}
          errorMessage={createKey.error ? errorText(createKey.error) : null}
        />
      )}

      {canMutate && created && (
        <KeyRevealBlock
          name={created.name ?? "New key"}
          secret={created.key}
          onDismiss={() => setCreated(null)}
        />
      )}

      {keys.length === 0 && (
        <p className="py-4 text-sm text-muted">
          {canMutate
            ? `No API keys in ${place} yet. Create one to call the API as this team.`
            : `No API keys in ${place} yet. A team admin can create one.`}
        </p>
      )}

      {keys.length > 0 && (
        <div className="divide-y divide-line border-t border-line">
          {keys.map((key) => (
            <TeamApiKeyRow
              key={key.id}
              teamId={teamId}
              apiKeyId={key.id}
              name={key.name}
              start={key.start}
              createdAt={key.createdAt}
              lastRequest={key.lastRequest}
              expiresAt={key.expiresAt}
              createdByLabel={creatorLabel(key.createdBy, directoryQ.data?.users)}
              revokeDisabled={!canMutate}
            />
          ))}
        </div>
      )}
    </div>
  );
}

/** A lifetime choice: days, or null for "No expiry". */
type LifetimeChoice = ApiKeyLifetimeDays | null;

function lifetimeLabel(days: LifetimeChoice): string {
  if (days === null) return "No expiry";
  return days === 365 ? "1 year" : `${days} days`;
}

/**
 * The create form for a personal or a team key: a name and an expiry. Under
 * an org maximum the expiry list hides "No expiry" and longer choices.
 */
function CreateKeyRow({
  maxLifetimeDays,
  locked = false,
  changeAt,
  onCreate,
  pending,
  errorMessage,
}: {
  maxLifetimeDays: number | null;
  /** The org turned personal keys off: the controls stay, disabled, with a managed note. */
  locked?: boolean;
  /** Where this viewer can turn them back on: the org Policies tab, for an org admin. */
  changeAt?: AppPath;
  onCreate: (input: CreateApiKeyInput, onSuccess: () => void) => void;
  pending: boolean;
  errorMessage: string | null;
}) {
  const [name, setName] = useState("");
  const [picked, setPicked] = useState<LifetimeChoice | undefined>(undefined);
  const choices = apiKeyLifetimeChoices(maxLifetimeDays);
  // The org maximum can arrive or change after a pick. A pick it no longer
  // allows falls back to the default choice.
  const lifetime = picked !== undefined && choices.includes(picked) ? picked : defaultApiKeyLifetime(maxLifetimeDays);

  function submit() {
    const trimmed = name.trim();
    if (!trimmed) return;
    onCreate(
      { name: trimmed, expiresIn: lifetime === null ? null : lifetime * SECONDS_PER_DAY },
      () => setName(""),
    );
  }

  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex flex-wrap gap-2">
        <Input
          value={name}
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") submit();
          }}
          placeholder="e.g. CI pipeline"
          aria-label="Key name"
          disabled={locked}
          className="min-w-0 flex-1"
        />
        <Select
          aria-label="Key expiry"
          className="w-auto shrink-0"
          disabled={locked}
          value={lifetime === null ? "none" : String(lifetime)}
          onChange={(e) => {
            const next = choices.find((choice) => (choice === null ? "none" : String(choice)) === e.target.value);
            if (next !== undefined) setPicked(next);
          }}
        >
          {choices.map((choice) => (
            <option key={choice ?? "none"} value={choice === null ? "none" : String(choice)}>
              {lifetimeLabel(choice)}
            </option>
          ))}
        </Select>
        <Button type="button" onClick={submit} disabled={locked || !name.trim() || pending}>
          {pending ? "Creating…" : "Create"}
        </Button>
      </div>
      {locked ? (
        <div className="space-y-0.5">
          <p className="text-xs text-muted">Personal API keys are off. Existing keys work until they expire or you revoke them.</p>
          <ManagedNote scope="org" askAdmin changeAt={changeAt} />
        </div>
      ) : maxLifetimeDays !== null && (
        <p className="text-xs text-muted">Your organization requires keys to expire within {lifetimeLabel(choices[choices.length - 1] ?? null)}.</p>
      )}
      {errorMessage && <p role="alert" className="text-sm text-danger-500">{errorMessage}</p>}
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
  expiresAt,
}: {
  apiKeyId: string;
  name: string | null;
  start: string | null;
  createdAt: Date | number;
  lastRequest: Date | number | null;
  expiresAt: Date | number | null;
}) {
  const revokeKey = useRevokeApiKey();
  return (
    <ApiKeyRow
      name={name}
      start={start}
      createdAt={createdAt}
      lastRequest={lastRequest}
      expiresAt={expiresAt}
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
  expiresAt,
  createdByLabel,
  revokeDisabled,
}: {
  teamId: string;
  apiKeyId: string;
  name: string | null;
  start: string | null;
  createdAt: Date | number;
  lastRequest: Date | number | null;
  expiresAt: Date | number | null;
  createdByLabel: string | null;
  revokeDisabled?: boolean;
}) {
  const revokeKey = useRevokeTeamApiKey(teamId);
  return (
    <ApiKeyRow
      name={name}
      start={start}
      createdAt={createdAt}
      lastRequest={lastRequest}
      expiresAt={expiresAt}
      createdByLabel={createdByLabel}
      revokeDisabled={revokeDisabled}
      pending={revokeKey.isPending}
      onRevoke={(done) => revokeKey.mutate(apiKeyId, { onSuccess: done })}
    />
  );
}

/** "Expires <date>", "Expired", or "No expiry" for a key row. */
function expiryText(expiresAt: Date | number | null, now: number = Date.now()): string {
  if (expiresAt === null) return "No expiry";
  const at = new Date(expiresAt).getTime();
  return at <= now ? "Expired" : `Expires ${formatDate(at)}`;
}

function ApiKeyRow({
  name,
  start,
  createdAt,
  lastRequest,
  expiresAt,
  createdByLabel,
  onRevoke,
  pending,
  revokeDisabled,
}: {
  name: string | null;
  start: string | null;
  createdAt: Date | number;
  lastRequest: Date | number | null;
  expiresAt: Date | number | null;
  /** Team rows only. A personal key has one possible creator. */
  createdByLabel?: string | null;
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
      {createdByLabel && (
        <div className="hidden shrink-0 text-xs text-muted sm:block">{createdByLabel}</div>
      )}
      <div className="hidden shrink-0 text-xs text-muted sm:block">
        Created {formatDateOr(createdAt, "—")}
      </div>
      <div className="hidden shrink-0 text-xs text-muted sm:block">
        Last used {formatDateOr(lastRequest, "Never")}
      </div>
      <div className="hidden shrink-0 text-xs text-muted sm:block">{expiryText(expiresAt)}</div>
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
