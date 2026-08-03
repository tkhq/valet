import { Fragment, useState } from "react";
import type {
  GetReposResponse,
  PrebuildConfigWire,
  PrebuildStatusWire,
  PrebuildWire,
} from "@valet/api/wire";
import { Badge, Button, Input, Spinner, Switch } from "~/components/primitives";
import { Section } from "~/components/settings/section";
import { ApiError } from "~/api/client";
import { relativeTime } from "~/lib/relative-time";
import { useRepos } from "~/api/repos";
import {
  useCreatePrebuildConfig,
  useDeletePrebuildConfig,
  useImageCatalog,
  usePatchPrebuildConfig,
  usePrebuildBuilds,
  usePrebuildConfigs,
  usePrebuildsMeta,
  useRebuildPrebuildConfig,
} from "~/api/settings";

type RepoOption = GetReposResponse["repos"][number];

/**
 * Organization · Sandbox images — per-repo prebuild configs (sandbox
 * images v2 plan, Task 6). Builder-absent (`meta.builder === null`) shows
 * a banner but the section still renders — configs can be created/edited
 * ahead of a builder being wired, only "Rebuild now" is blocked (the API
 * 409s with a verbatim "unavailable on this deployment" message).
 */
export function PrebuildsSection() {
  const metaQ = usePrebuildsMeta();
  const configsQ = usePrebuildConfigs();
  const catalogQ = useImageCatalog();
  const configs = configsQ.data?.configs ?? [];
  const catalog = catalogQ.data?.images ?? [];

  return (
    <Section
      title="Prebuilds"
      description="Nightly or on-demand images pre-built from a repo's dependencies, so sessions boot without a cold install."
    >
      {metaQ.data && metaQ.data.builder === null && (
        <div
          role="status"
          className="rounded border border-line bg-ink-wash px-3 py-2 text-sm text-muted"
        >
          Prebuilds are unavailable on this deployment
        </div>
      )}

      {configsQ.isLoading && (
        <div className="flex items-center gap-2 py-4 text-sm text-muted">
          <Spinner size={14} /> Loading…
        </div>
      )}
      {configsQ.error && <p className="py-4 text-sm text-danger-500">Failed to load prebuild configs.</p>}

      {configsQ.data && (
        <div className="divide-y divide-line">
          {configs.map((config) => (
            <PrebuildConfigCard key={config.id} config={config} catalog={catalog} />
          ))}
          <CreatePrebuildConfigRow existingFullNames={configs.map((c) => c.repoFullName).filter((n): n is string => n !== null)} />
        </div>
      )}
    </Section>
  );
}

const STATUS_VARIANT: Record<PrebuildStatusWire, "neutral" | "accent" | "success" | "danger"> = {
  queued: "neutral",
  building: "accent",
  pushed: "success",
  failed: "danger",
};

function shortSha(sha: string): string {
  return sha.slice(0, 7);
}

function PrebuildConfigCard({
  config,
  catalog,
}: {
  config: PrebuildConfigWire;
  catalog: { id: string; name: string }[];
}) {
  const patchConfig = usePatchPrebuildConfig();
  const deleteConfig = useDeletePrebuildConfig();
  const rebuild = useRebuildPrebuildConfig();
  const buildsQ = usePrebuildBuilds(config.id);
  const [rebuildError, setRebuildError] = useState<string | null>(null);

  function handleRebuild() {
    setRebuildError(null);
    rebuild.mutate(config.id, {
      onError: (err) => {
        if (err instanceof ApiError && typeof err.payload === "object" && err.payload !== null) {
          const payload = err.payload as { error?: string };
          setRebuildError(payload.error ?? err.message);
        } else {
          setRebuildError(err.message);
        }
      },
    });
  }

  return (
    <div className="space-y-3 py-4">
      <div className="flex items-center justify-between gap-3">
        <span className="truncate text-sm font-medium text-ink">{config.repoFullName}</span>
        <div className="flex items-center gap-3">
          <label className="flex items-center gap-2 text-xs text-muted">
            Enabled
            <Switch
              checked={config.enabled}
              onCheckedChange={(checked) => patchConfig.mutate({ id: config.id, body: { enabled: checked } })}
              aria-label={`Enable prebuilds for ${config.repoFullName}`}
            />
          </label>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={() => deleteConfig.mutate(config.id)}
            disabled={deleteConfig.isPending}
          >
            Remove
          </Button>
        </div>
      </div>

      <div className="flex flex-wrap items-end gap-3">
        <div className="space-y-1">
          <label className="block text-xs text-muted" htmlFor={`base-image-${config.id}`}>
            Base image
          </label>
          <select
            id={`base-image-${config.id}`}
            value={config.parentId ?? ""}
            onChange={(e) =>
              patchConfig.mutate({ id: config.id, body: { baseImageId: e.target.value || null } })
            }
            className="h-8 rounded border border-[--border] bg-[--bg] px-2 text-sm text-[--fg]"
          >
            <option value="">Stock sandbox image</option>
            {catalog.map((image) => (
              <option key={image.id} value={image.id}>
                {image.name}
              </option>
            ))}
          </select>
        </div>

        <label className="flex items-center gap-2 text-xs text-muted">
          Nightly rebuilds
          <Switch
            checked={config.schedule === "nightly"}
            onCheckedChange={(checked) =>
              patchConfig.mutate({ id: config.id, body: { schedule: checked ? "nightly" : "off" } })
            }
            aria-label={`Nightly rebuilds for ${config.repoFullName}`}
          />
        </label>

        <Button type="button" variant="secondary" size="sm" onClick={handleRebuild} disabled={rebuild.isPending}>
          {rebuild.isPending ? "Starting…" : "Rebuild now"}
        </Button>
      </div>

      {rebuildError && <p className="text-xs text-danger-500">{rebuildError}</p>}

      <BuildHistoryTable builds={buildsQ.data?.builds ?? []} loading={buildsQ.isLoading} />
    </div>
  );
}

function BuildHistoryTable({ builds, loading }: { builds: PrebuildWire[]; loading: boolean }) {
  const [expandedId, setExpandedId] = useState<string | null>(null);

  if (loading) {
    return (
      <div className="flex items-center gap-2 text-xs text-muted">
        <Spinner size={12} /> Loading builds…
      </div>
    );
  }
  if (builds.length === 0) {
    return <p className="text-xs text-muted">No builds yet.</p>;
  }

  return (
    <table className="w-full text-left text-xs">
      <thead>
        <tr className="text-muted">
          <th className="py-1 pr-3 font-medium">Status</th>
          <th className="py-1 pr-3 font-medium">Commit</th>
          <th className="py-1 pr-3 font-medium">When</th>
        </tr>
      </thead>
      <tbody>
        {builds.map((build) => {
          const expanded = expandedId === build.id;
          const hasDetail = Boolean(build.logTail || build.error);
          return (
            <Fragment key={build.id}>
              <tr className="border-t border-line">
                <td className="py-1.5 pr-3">
                  <Badge variant={STATUS_VARIANT[build.status]}>{build.status}</Badge>
                </td>
                <td className="py-1.5 pr-3 font-mono text-ink">{build.commitSha ? shortSha(build.commitSha) : "—"}</td>
                <td className="py-1.5 pr-3 text-muted">
                  {build.finishedAt
                    ? relativeTime(build.finishedAt)
                    : build.startedAt
                      ? `started ${relativeTime(build.startedAt)}`
                      : "queued"}
                  {hasDetail && (
                    <button
                      type="button"
                      className="ml-2 text-moss underline"
                      onClick={() => setExpandedId(expanded ? null : build.id)}
                    >
                      {expanded ? "Hide details" : "Details"}
                    </button>
                  )}
                </td>
              </tr>
              {expanded && (
                <tr className="border-t border-line">
                  <td colSpan={3} className="py-1.5 pr-3">
                    {build.error && <p className="text-danger-500">{build.error}</p>}
                    {build.logTail && (
                      <pre className="mt-1 max-h-40 overflow-y-auto whitespace-pre-wrap rounded bg-ink-wash p-2 text-[11px] text-muted">
                        {build.logTail}
                      </pre>
                    )}
                  </td>
                </tr>
              )}
            </Fragment>
          );
        })}
      </tbody>
    </table>
  );
}

/**
 * Repo picker for creating a new prebuild config. Deliberately a
 * standalone ~30-line combobox rather than importing
 * `new-session-dialog.tsx`'s `RepoCombobox` — that component is a
 * module-private function tied to the dialog's `RepoOption`/`installed`
 * badge rendering, and extracting a shared generic version isn't worth the
 * indirection for a picker this small.
 */
function CreatePrebuildConfigRow({ existingFullNames }: { existingFullNames: string[] }) {
  const reposQ = useRepos();
  const createConfig = useCreatePrebuildConfig();
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const repos = reposQ.data?.repos ?? [];
  const available = repos.filter((r) => !existingFullNames.includes(r.fullName));
  const matches = available.filter((r) => r.fullName.toLowerCase().includes(query.trim().toLowerCase()));

  function select(repo: RepoOption) {
    setError(null);
    createConfig.mutate(
      {
        repoFullName: repo.fullName,
        cloneUrl: repo.cloneUrl ?? repo.url,
        repoHost: "github",
      },
      {
        onSuccess: () => {
          setQuery("");
          setOpen(false);
        },
        onError: (err) => setError(err.message),
      },
    );
  }

  return (
    <div className="space-y-2 py-4">
      <div className="relative">
        <Input
          value={query}
          placeholder="Search repositories to add a prebuild config"
          onFocus={() => setOpen(true)}
          onClick={() => setOpen(true)}
          onChange={(e) => {
            setQuery(e.target.value);
            setOpen(true);
          }}
          onKeyDown={(e) => {
            if (e.key === "Escape") setOpen(false);
          }}
          onBlur={() => {
            setTimeout(() => setOpen(false), 120);
          }}
          aria-label="Search repositories to add a prebuild config"
          role="combobox"
          aria-expanded={open}
        />
        {open && (
          <div
            role="listbox"
            aria-label="Repository results"
            className="absolute z-10 mt-1 max-h-56 w-full overflow-y-auto rounded border border-line bg-paper py-1 shadow-lg"
          >
            {matches.length === 0 && (
              <div className="px-3 py-1.5 text-sm text-muted">No matching repos.</div>
            )}
            {matches.map((r) => (
              <button
                key={r.fullName}
                type="button"
                role="option"
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => select(r)}
                className="flex w-full items-center justify-between gap-2 px-3 py-1.5 text-left text-sm hover:bg-ink-wash"
              >
                <span className="truncate text-ink">{r.fullName}</span>
              </button>
            ))}
          </div>
        )}
      </div>
      {error && <p className="text-xs text-danger-500">{error}</p>}
    </div>
  );
}
