import { useState } from "react";
import { Trash2 } from "lucide-react";
import type { LlmProviderKindWire, LlmProviderModelWire, LlmProviderSummary } from "@valet/api/wire";
import {
  Badge,
  Button,
  Dialog,
  DialogContent,
  DialogFooter,
  Input,
  Label,
  Spinner,
  Switch,
} from "~/components/primitives";
import { Section } from "~/components/settings/section";
import { ApiError } from "~/api/client";
import {
  useCreateLlmProvider,
  useDeleteLlmProvider,
  useDeleteLlmProviderKey,
  useLlmProviders,
  usePatchLlmProvider,
  useProbeLlmProvider,
  usePutLlmProviderKey,
  useTestLlmProvider,
} from "~/api/settings";

const KNOWN_KINDS: readonly LlmProviderKindWire[] = ["anthropic", "openai", "google"];

const KNOWN_LABEL: Record<"anthropic" | "openai" | "google", string> = {
  anthropic: "Anthropic",
  openai: "OpenAI",
  google: "Google",
};

/**
 * Organization · Models — provider configuration (llm-providers design,
 * plan Task 7). One card per known provider kind (anthropic/openai/google,
 * created implicitly on first key save/toggle) plus any number of custom
 * `openai_compatible` providers with a create form below the list.
 */
export function LlmProvidersSection() {
  const providersQ = useLlmProviders();
  const providers = providersQ.data?.providers ?? [];
  const knownRows = new Map(
    providers.filter((p) => p.kind !== "openai_compatible").map((p) => [p.kind, p]),
  );
  const customRows = providers.filter((p) => p.kind === "openai_compatible");

  return (
    <Section title="Providers" description="Connect model providers and manage API keys.">
      {providersQ.isLoading && (
        <div className="flex items-center gap-2 py-4 text-sm text-muted">
          <Spinner size={14} /> Loading…
        </div>
      )}
      {providersQ.error && (
        <p className="py-4 text-sm text-danger-500">Failed to load providers.</p>
      )}

      {providersQ.data && (
        <div className="divide-y divide-line">
          {KNOWN_KINDS.map((kind) => (
            <KnownProviderCard
              key={kind}
              kind={kind as "anthropic" | "openai" | "google"}
              row={knownRows.get(kind)}
            />
          ))}
          {customRows.map((row) => (
            <CustomProviderCard key={row.id} provider={row} />
          ))}
          <CreateCustomProviderRow />
        </div>
      )}
    </Section>
  );
}

// ── Known-provider (anthropic/openai/google) card ──────────────────────────

function KnownProviderCard({
  kind,
  row,
}: {
  kind: "anthropic" | "openai" | "google";
  row: LlmProviderSummary | undefined;
}) {
  const createProvider = useCreateLlmProvider();
  const patchProvider = usePatchLlmProvider();
  const putKey = usePutLlmProviderKey();
  const deleteKey = useDeleteLlmProviderKey();
  const [apiKey, setApiKey] = useState("");
  const [error, setError] = useState<string | null>(null);

  async function ensureRowId(): Promise<string> {
    if (row) return row.id;
    const created = await createProvider.mutateAsync({ kind, name: KNOWN_LABEL[kind] });
    return created.id;
  }

  async function handleSaveKey() {
    const trimmed = apiKey.trim();
    if (!trimmed) return;
    setError(null);
    try {
      const id = await ensureRowId();
      await putKey.mutateAsync({ id, body: { apiKey: trimmed } });
      setApiKey("");
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  async function handleToggleEnabled(checked: boolean) {
    if (!row) return;
    patchProvider.mutate({ id: row.id, body: { enabled: checked } });
  }

  function handleRemoveKey() {
    if (!row) return;
    deleteKey.mutate(row.id);
  }

  const placeholder = row?.hasKey ? `••••${row.keyLast4}` : "sk-…";
  const showDeploymentBadge = Boolean(row?.envFallback && !row.hasKey);

  return (
    <div className="space-y-3 py-4">
      <div className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <span className="text-sm font-medium text-ink">{KNOWN_LABEL[kind]}</span>
          {showDeploymentBadge && <Badge variant="neutral">using deployment key</Badge>}
        </div>
        {row && (
          <Switch
            checked={row.enabled}
            onCheckedChange={handleToggleEnabled}
            aria-label={`Enable ${KNOWN_LABEL[kind]}`}
          />
        )}
      </div>

      <div className="flex items-end gap-2">
        <div className="flex-1 space-y-1">
          <Label htmlFor={`${kind}-key`}>API key</Label>
          <Input
            id={`${kind}-key`}
            type="password"
            value={apiKey}
            onChange={(e) => setApiKey(e.target.value)}
            placeholder={placeholder}
            autoComplete="off"
          />
        </div>
        <Button
          type="button"
          onClick={handleSaveKey}
          disabled={!apiKey.trim() || putKey.isPending}
        >
          {putKey.isPending ? "Saving…" : "Save"}
        </Button>
        {row?.hasKey && (
          <Button type="button" variant="secondary" onClick={handleRemoveKey}>
            Remove key
          </Button>
        )}
      </div>
      {error && <p className="text-xs text-danger-500">{error}</p>}
    </div>
  );
}

// ── Custom (openai_compatible) provider card ────────────────────────────────

function CustomProviderCard({ provider }: { provider: LlmProviderSummary }) {
  const patchProvider = usePatchLlmProvider();
  const deleteProvider = useDeleteLlmProvider();
  const putKey = usePutLlmProviderKey();
  const deleteKey = useDeleteLlmProviderKey();
  const probe = useProbeLlmProvider();
  const test = useTestLlmProvider();

  const [name, setName] = useState(provider.name);
  const [baseUrl, setBaseUrl] = useState(provider.baseUrl ?? "");
  const [apiKey, setApiKey] = useState("");
  const [probedIds, setProbedIds] = useState<string[]>([]);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(
    () => new Set(provider.models.map((m) => m.id)),
  );
  const [testModelId, setTestModelId] = useState(provider.models[0]?.id ?? "");
  const [testResult, setTestResult] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const knownIds = new Set([...provider.models.map((m) => m.id), ...probedIds]);

  function handleSaveDetails() {
    patchProvider.mutate({
      id: provider.id,
      body: { name: name.trim() || provider.name, baseUrl: baseUrl.trim() },
    });
  }

  async function handleSaveKey() {
    const trimmed = apiKey.trim();
    if (!trimmed) return;
    setError(null);
    try {
      await putKey.mutateAsync({ id: provider.id, body: { apiKey: trimmed } });
      setApiKey("");
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  function handleFetchModels() {
    setError(null);
    probe.mutate(provider.id, {
      onSuccess: (resp) => setProbedIds(resp.models.map((m) => m.id)),
      onError: (err) => setError(err.message),
    });
  }

  function toggleModel(id: string) {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function handleSaveModels() {
    const models: LlmProviderModelWire[] = Array.from(selectedIds).map((id) => {
      const existing = provider.models.find((m) => m.id === id);
      return { id, name: existing?.name ?? id };
    });
    patchProvider.mutate({ id: provider.id, body: { models } });
  }

  function handleTest() {
    if (!testModelId) return;
    setTestResult(null);
    test.mutate(
      { id: provider.id, body: { modelId: testModelId } },
      {
        onSuccess: (resp) =>
          setTestResult(resp.ok ? `OK — ${resp.latencyMs}ms` : resp.error),
        onError: (err) => setTestResult(err.message),
      },
    );
  }

  return (
    <div className="space-y-3 py-4">
      <div className="flex items-center justify-between gap-3">
        <span className="text-sm font-medium text-ink">{provider.name} (custom)</span>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          aria-label={`Delete ${provider.name}`}
          onClick={() => setConfirmDelete(true)}
        >
          <Trash2 className="h-4 w-4" aria-hidden />
        </Button>
      </div>

      <div className="flex gap-2">
        <div className="flex-1 space-y-1">
          <Label htmlFor={`${provider.id}-name`}>Name</Label>
          <Input id={`${provider.id}-name`} value={name} onChange={(e) => setName(e.target.value)} />
        </div>
        <div className="flex-1 space-y-1">
          <Label htmlFor={`${provider.id}-baseUrl`}>Base URL</Label>
          <Input
            id={`${provider.id}-baseUrl`}
            value={baseUrl}
            onChange={(e) => setBaseUrl(e.target.value)}
          />
        </div>
        <Button type="button" variant="secondary" onClick={handleSaveDetails}>
          Save
        </Button>
      </div>

      <div className="flex items-end gap-2">
        <div className="flex-1 space-y-1">
          <Label htmlFor={`${provider.id}-key`}>API key</Label>
          <Input
            id={`${provider.id}-key`}
            type="password"
            value={apiKey}
            onChange={(e) => setApiKey(e.target.value)}
            placeholder={provider.hasKey ? `••••${provider.keyLast4}` : "sk-…"}
            autoComplete="off"
          />
        </div>
        <Button type="button" onClick={handleSaveKey} disabled={!apiKey.trim() || putKey.isPending}>
          {putKey.isPending ? "Saving…" : "Save"}
        </Button>
        {provider.hasKey && (
          <Button type="button" variant="secondary" onClick={() => deleteKey.mutate(provider.id)}>
            Remove key
          </Button>
        )}
      </div>

      <div className="space-y-2">
        <div className="flex items-center gap-2">
          <span className="text-xs font-medium uppercase tracking-wider text-muted">Models</span>
          <Button type="button" variant="ghost" size="sm" onClick={handleFetchModels} disabled={probe.isPending}>
            {probe.isPending ? "Fetching…" : "Fetch models"}
          </Button>
          {selectedIds.size > 0 && (
            <Button type="button" variant="ghost" size="sm" onClick={handleSaveModels}>
              Save models
            </Button>
          )}
        </div>
        {knownIds.size > 0 && (
          <div className="flex flex-wrap gap-3">
            {Array.from(knownIds).map((id) => (
              <label key={id} className="flex items-center gap-1.5 text-sm text-ink">
                <input
                  type="checkbox"
                  checked={selectedIds.has(id)}
                  onChange={() => toggleModel(id)}
                />
                {id}
              </label>
            ))}
          </div>
        )}
      </div>

      {provider.models.length > 0 && (
        <div className="flex flex-wrap items-center gap-2">
          <select
            aria-label={`Test model for ${provider.name}`}
            value={testModelId}
            onChange={(e) => setTestModelId(e.target.value)}
            className="h-8 rounded border border-[--border] bg-[--bg] px-2 text-sm"
          >
            {provider.models.map((m) => (
              <option key={m.id} value={m.id}>
                {m.name}
              </option>
            ))}
          </select>
          <Button type="button" variant="secondary" size="sm" onClick={handleTest} disabled={test.isPending}>
            {test.isPending ? "Testing…" : "Test"}
          </Button>
          {testResult && <span className="text-xs text-muted">{testResult}</span>}
        </div>
      )}

      {error && <p className="text-xs text-danger-500">{error}</p>}

      <Dialog open={confirmDelete} onOpenChange={setConfirmDelete}>
        <DialogContent
          title={`Delete ${provider.name}?`}
          description="This removes the provider and its stored key. It cannot be undone."
        >
          <DialogFooter>
            <Button type="button" variant="secondary" onClick={() => setConfirmDelete(false)}>
              Cancel
            </Button>
            <Button
              type="button"
              variant="danger"
              disabled={deleteProvider.isPending}
              onClick={() => {
                deleteProvider.mutate(provider.id, {
                  onSuccess: () => setConfirmDelete(false),
                  onError: (err) => {
                    setConfirmDelete(false);
                    if (err instanceof ApiError && typeof err.payload === "object" && err.payload !== null) {
                      const payload = err.payload as { error?: string };
                      setError(payload.error ?? err.message);
                    } else {
                      setError(err.message);
                    }
                  },
                });
              }}
            >
              {deleteProvider.isPending ? "Deleting…" : "Delete provider"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

// ── Create custom provider ──────────────────────────────────────────────────

function CreateCustomProviderRow() {
  const createProvider = useCreateLlmProvider();
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [baseUrl, setBaseUrl] = useState("");
  const [error, setError] = useState<string | null>(null);

  function submit() {
    if (!name.trim() || !baseUrl.trim()) return;
    setError(null);
    createProvider.mutate(
      { kind: "openai_compatible", name: name.trim(), baseUrl: baseUrl.trim() },
      {
        onSuccess: () => {
          setName("");
          setBaseUrl("");
          setOpen(false);
        },
        onError: (err) => setError(err.message),
      },
    );
  }

  if (!open) {
    return (
      <div className="py-4">
        <Button type="button" variant="secondary" onClick={() => setOpen(true)}>
          Add custom provider
        </Button>
      </div>
    );
  }

  return (
    <div className="space-y-2 py-4">
      <div className="flex gap-2">
        <div className="flex-1 space-y-1">
          <Label htmlFor="new-provider-name">Name</Label>
          <Input id="new-provider-name" value={name} onChange={(e) => setName(e.target.value)} />
        </div>
        <div className="flex-1 space-y-1">
          <Label htmlFor="new-provider-baseUrl">Base URL</Label>
          <Input
            id="new-provider-baseUrl"
            value={baseUrl}
            onChange={(e) => setBaseUrl(e.target.value)}
            placeholder="https://api.example.com/v1"
          />
        </div>
      </div>
      <div className="flex gap-2">
        <Button type="button" onClick={submit} disabled={!name.trim() || !baseUrl.trim() || createProvider.isPending}>
          {createProvider.isPending ? "Creating…" : "Create"}
        </Button>
        <Button type="button" variant="ghost" onClick={() => setOpen(false)}>
          Cancel
        </Button>
      </div>
      {error && <p className="text-xs text-danger-500">{error}</p>}
    </div>
  );
}
