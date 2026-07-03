import * as React from 'react';
import { createFileRoute, useNavigate } from '@tanstack/react-router';
import { Card, CardHeader, CardTitle, CardDescription, CardFooter } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { SearchInput } from '@/components/ui/search-input';
import { Skeleton } from '@/components/ui/skeleton';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogFooter,
  DialogTitle,
  DialogDescription,
} from '@/components/ui/dialog';
import { toastSuccess, toastError } from '@/hooks/use-toast';
import { getServiceIcon } from '@/components/integrations/service-icons';
import { cn } from '@/lib/cn';
import { useWorkflowTemplates, useInstallTemplate, useGithubAppInstallations, useEnableTemplateApp } from '@/api/templates';
import { useRunWorkflow } from '@/api/workflows';
import { useTriggers } from '@/api/triggers';
import { useRepos, useRepoPulls } from '@/api/repos';
import { useGitHubStatus } from '@/api/github';
import type { WorkflowTemplateSummary, InstalledTemplateTrigger } from '@valet/shared';

export const Route = createFileRoute('/automation/templates/')({
  component: TemplatesPage,
});

function TemplatesPage() {
  const { data, isLoading, error } = useWorkflowTemplates();
  const [query, setQuery] = React.useState('');
  const [category, setCategory] = React.useState('All');

  const templates = data?.templates ?? [];
  const categories = ['All', ...Array.from(new Set(templates.map((t) => t.category)))];

  const filtered = templates.filter((t) => {
    const matchesCategory = category === 'All' || t.category === category;
    const q = query.trim().toLowerCase();
    const matchesQuery = !q || `${t.name} ${t.description}`.toLowerCase().includes(q);
    return matchesCategory && matchesQuery;
  });

  return (
    <div className="flex flex-col gap-5">
      <div className="flex flex-col gap-1">
        <h2 className="text-lg font-medium text-neutral-900 dark:text-neutral-100">Templates</h2>
        <p className="text-sm text-neutral-500 dark:text-neutral-400">
          Start from a pre-built automation. Pick one, connect it, and it runs.
        </p>
      </div>

      {/* Search + category filters (Zapier-style) */}
      <div className="flex flex-col gap-3">
        <div className="max-w-md">
          <SearchInput placeholder="Search templates" value={query} onChange={setQuery} debounceMs={0} />
        </div>
        <div className="flex flex-wrap gap-2">
          {categories.map((c) => {
            const active = c === category;
            return (
              <button
                key={c}
                onClick={() => setCategory(c)}
                className={cn(
                  'rounded-full border px-3 py-1 text-sm transition-colors',
                  active
                    ? 'border-accent bg-accent/10 text-accent'
                    : 'border-neutral-200 text-neutral-600 hover:border-neutral-300 hover:text-neutral-900 dark:border-neutral-700 dark:text-neutral-300 dark:hover:text-neutral-100',
                )}
              >
                {c}
              </button>
            );
          })}
        </div>
      </div>

      {isLoading ? (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {Array.from({ length: 3 }).map((_, i) => (
            <Skeleton key={i} className="h-44 rounded-xl" />
          ))}
        </div>
      ) : error ? (
        <div className="rounded-lg border border-red-200 bg-red-50 p-4 dark:border-red-800 dark:bg-red-950">
          <p className="text-sm text-pretty text-red-600 dark:text-red-400">
            Failed to load templates. Please try again.
          </p>
        </div>
      ) : filtered.length === 0 ? (
        <div className="flex h-44 flex-col items-center justify-center gap-1 text-center">
          <p className="text-sm font-medium text-neutral-700 dark:text-neutral-300">No matching templates</p>
          <p className="text-sm text-neutral-500">Try a different search or category.</p>
        </div>
      ) : (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {filtered.map((t) => (
            <TemplateCard key={t.id} template={t} />
          ))}
        </div>
      )}
    </div>
  );
}

function TemplateCard({ template }: { template: WorkflowTemplateSummary }) {
  const [open, setOpen] = React.useState(false);
  return (
    <>
      <Card className="group flex flex-col rounded-xl transition-shadow hover:shadow-md">
        <CardHeader className="flex-1">
          <AppChain apps={template.apps} />
          <CardTitle className="mt-3 text-[15px] font-medium leading-snug">{template.name}</CardTitle>
          <CardDescription className="mt-1 line-clamp-2">{template.description}</CardDescription>
        </CardHeader>
        <CardFooter className="flex items-center justify-between">
          <Badge variant="secondary">{template.category}</Badge>
          <Button
            size="sm"
            variant="outline"
            className="group-hover:border-accent group-hover:text-accent"
            onClick={() => setOpen(true)}
          >
            Try it
          </Button>
        </CardFooter>
      </Card>
      <TemplateSetupDialog open={open} onOpenChange={setOpen} template={template} />
    </>
  );
}

/** The trigger → … → action app-logo chain (Zapier's signature card visual). */
function AppChain({ apps }: { apps: string[] }) {
  return (
    <div className="flex items-center gap-1.5">
      {apps.map((app, i) => (
        <React.Fragment key={i}>
          {i > 0 && <ChevronRightIcon className="h-3.5 w-3.5 shrink-0 text-neutral-300 dark:text-neutral-600" />}
          <AppTile service={app} />
        </React.Fragment>
      ))}
    </div>
  );
}

function AppTile({ service, size = 'md' }: { service: string; size?: 'md' | 'lg' }) {
  const box = size === 'lg' ? 'h-10 w-10' : 'h-8 w-8';
  const glyph = size === 'lg' ? 'h-5 w-5' : 'h-4 w-4';
  return (
    <span
      className={cn('flex items-center justify-center rounded-lg border border-neutral-200 bg-white dark:border-neutral-700 dark:bg-neutral-900', box)}
    >
      <AppGlyph service={service} className={glyph} />
    </span>
  );
}

/** Reuses the app's brand logos; the LLM review step gets a Claude spark mark. */
function AppGlyph({ service, className }: { service: string; className?: string }) {
  if (service === 'claude' || service === 'anthropic') {
    return <ClaudeMark className={cn(className, 'text-[#C15F3C]')} />;
  }
  const Icon = getServiceIcon(service);
  return <Icon className={cn(className, 'text-neutral-800 dark:text-neutral-100')} />;
}

/** A guided setup, in the spirit of Zapier's "Try it": shows the steps, then installs + runs. */
function TemplateSetupDialog({
  open,
  onOpenChange,
  template,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  template: WorkflowTemplateSummary;
}) {
  const navigate = useNavigate();
  const install = useInstallTemplate();
  const run = useRunWorkflow();
  const [installedWorkflowId, setInstalledWorkflowId] = React.useState<string | null>(null);
  const [webhook, setWebhook] = React.useState<InstalledTemplateTrigger | null>(null);
  const [values, setValues] = React.useState<Record<string, string>>({});

  // Reset per-install state when the dialog closes, so reopening the same
  // template starts fresh instead of showing a stale "already installed" form.
  React.useEffect(() => {
    if (!open) {
      setInstalledWorkflowId(null);
      setWebhook(null);
      setValues({});
    }
  }, [open]);

  const handleInstall = () => {
    install.mutate(template.id, {
      onSuccess: (res) => {
        setInstalledWorkflowId(res.workflowId);
        if (res.trigger) setWebhook(res.trigger);
      },
      onError: (err) =>
        toastError('Couldn’t add template', err instanceof Error ? err.message : 'Something went wrong.'),
    });
  };

  const runNow = () => {
    if (!installedWorkflowId) return;
    const variables: Record<string, unknown> = {};
    for (const input of template.inputs) {
      const raw = values[input.name] ?? '';
      variables[input.name] = input.type === 'number' ? Number(raw) : raw;
    }
    run.mutate(
      { workflowId: installedWorkflowId, variables },
      {
        onSuccess: () => {
          toastSuccess('Run started', 'Check the run history for the result.');
          onOpenChange(false);
          navigate({ to: '/automation/workflows/$workflowId', params: { workflowId: installedWorkflowId } });
        },
        onError: (err) =>
          toastError('Run failed', err instanceof Error ? err.message : 'Could not start the run.'),
      },
    );
  };

  const missingRequired = template.inputs.some((i) => i.required && !(values[i.name] ?? '').trim());

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{template.name}</DialogTitle>
          <DialogDescription>{template.description}</DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-4">
          <div className="flex items-center gap-2">
            {template.apps.map((app, i) => (
              <React.Fragment key={i}>
                {i > 0 && <ChevronRightIcon className="h-4 w-4 shrink-0 text-neutral-300 dark:text-neutral-600" />}
                <AppTile service={app} size="lg" />
              </React.Fragment>
            ))}
          </div>

          <ol className="flex flex-col gap-2">
            {template.steps.map((step, i) => (
              <li key={i} className="flex items-start gap-2.5 text-sm text-neutral-700 dark:text-neutral-300">
                <span className="mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-neutral-100 font-mono text-2xs text-neutral-500 dark:bg-neutral-800 dark:text-neutral-400">
                  {i + 1}
                </span>
                {step}
              </li>
            ))}
          </ol>

          {installedWorkflowId && (
            <div className="flex flex-col gap-4 border-t border-neutral-100 pt-4 dark:border-neutral-800">
              {/* Primary: the GitHub App is the recommended way to install for a repo — no webhook setup. */}
              {template.runForm === 'github-pr' ? (
                <GithubAppInstallSection templateId={template.id} workflowId={installedWorkflowId} webhook={webhook} />
              ) : (
                webhook && (
                  <div className="flex flex-col gap-2">
                    <p className="text-sm font-medium text-neutral-700 dark:text-neutral-300">
                      Install it for a repository
                    </p>
                    <p className="text-xs text-neutral-500 dark:text-neutral-400">
                      Add this webhook to a GitHub repo (Settings → Webhooks, content type{' '}
                      <code className="rounded bg-neutral-100 px-1 dark:bg-neutral-800">application/json</code>,
                      event <em>Pull requests</em>). It then reviews every new or updated PR there — no per-PR setup.
                    </p>
                    <WebhookSecret trigger={webhook} />
                  </div>
                )
              )}

              {/* Secondary: an optional one-off test against a single PR. */}
              {template.inputs.length > 0 && (
                <div className="flex flex-col gap-2">
                  <p className="text-sm font-medium text-neutral-700 dark:text-neutral-300">
                    Test on one PR{' '}
                    <span className="font-normal text-neutral-400 dark:text-neutral-500">(optional)</span>
                  </p>
                  {template.runForm === 'github-pr' ? (
                    <GithubPrRunFields values={values} onChange={setValues} />
                  ) : (
                    template.inputs.map((input) => (
                      <div key={input.name} className="flex flex-col gap-1">
                        <label className="text-sm text-neutral-600 dark:text-neutral-400">
                          {input.label}
                          {input.required && <span className="text-red-500"> *</span>}
                        </label>
                        <Input
                          type={input.type === 'number' ? 'number' : 'text'}
                          placeholder={input.placeholder}
                          value={values[input.name] ?? ''}
                          onChange={(e) => setValues((prev) => ({ ...prev, [input.name]: e.target.value }))}
                        />
                      </div>
                    ))
                  )}
                </div>
              )}
            </div>
          )}
        </div>

        <DialogFooter>
          {!installedWorkflowId ? (
            <>
              <Button variant="ghost" size="sm" onClick={() => onOpenChange(false)}>
                Cancel
              </Button>
              <Button size="sm" onClick={handleInstall} disabled={install.isPending}>
                {install.isPending ? 'Adding…' : 'Use this template'}
              </Button>
            </>
          ) : (
            <>
              <Button
                variant="ghost"
                size="sm"
                onClick={() =>
                  navigate({
                    to: '/automation/workflows/$workflowId',
                    params: { workflowId: installedWorkflowId },
                  })
                }
              >
                Open workflow
              </Button>
              {template.inputs.length > 0 && (
                <Button size="sm" onClick={runNow} disabled={run.isPending || missingRequired}>
                  {run.isPending ? 'Starting…' : 'Test now'}
                </Button>
              )}
            </>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

const selectClassName =
  'h-9 w-full rounded-md border border-neutral-300 bg-white px-3 text-sm text-neutral-900 focus:border-neutral-500 focus:outline-none focus:ring-1 focus:ring-neutral-500 disabled:opacity-50 dark:border-neutral-600 dark:bg-neutral-900 dark:text-neutral-100 dark:focus:border-neutral-400 dark:focus:ring-neutral-400';

/**
 * "Install it for a repository" for the code-review template — the recommended path.
 * Pick a connected repo; if the Valet GitHub App is installed on that owner, one
 * click enables reviews on every PR (posted as the bot, no webhook). Otherwise the
 * manual webhook below is the fallback.
 */
function GithubAppInstallSection({
  templateId,
  workflowId,
  webhook,
}: {
  templateId: string;
  workflowId: string;
  webhook: InstalledTemplateTrigger | null;
}) {
  const { data: reposData, isLoading: reposLoading } = useRepos();
  const repos = reposData?.repos ?? [];
  const { data: installationsData } = useGithubAppInstallations();
  const installations = installationsData?.installations ?? [];
  const { data: triggersData } = useTriggers();
  const { data: ghStatus } = useGitHubStatus();
  const appSlug = ghStatus?.appSlug ?? null;
  const enableApp = useEnableTemplateApp();

  const [owner, setOwner] = React.useState('');
  const [repo, setRepo] = React.useState('');
  const [justInstalled, setJustInstalled] = React.useState(false);

  const covered =
    !!owner && installations.some((i) => i.accountLogin.toLowerCase() === owner.toLowerCase());

  // A github-app trigger already exists for this repo → it's installed. Show the
  // confirmation instead of the button so the user can't double-install.
  const alreadyInstalled =
    !!owner && !!repo && (triggersData?.triggers ?? []).some(
      (t) =>
        t.type === 'github-app' &&
        t.enabled &&
        t.config.type === 'github-app' &&
        t.config.owner.toLowerCase() === owner.toLowerCase() &&
        t.config.repo.toLowerCase() === repo.toLowerCase(),
    );
  const installed = justInstalled || alreadyInstalled;

  const handleEnable = () => {
    enableApp.mutate(
      { templateId, workflowId, owner, repo },
      {
        onSuccess: (res) => {
          setJustInstalled(true);
          if (res.alreadyArmed) {
            toastSuccess('Already installed', `${owner}/${repo} is already reviewed on every PR.`);
          } else {
            toastSuccess(
              'Enabled',
              `Reviews every PR on ${owner}/${repo}, posted as the bot. No webhook setup needed.`,
            );
          }
        },
        onError: (err) =>
          toastError('Couldn’t enable', err instanceof Error ? err.message : 'Something went wrong.'),
      },
    );
  };

  return (
    <div className="flex flex-col gap-2">
      <p className="text-sm font-medium text-neutral-700 dark:text-neutral-300">
        Install it for a repository
      </p>
      <p className="text-xs text-neutral-500 dark:text-neutral-400">
        Pick a connected repo. If the Valet GitHub App is installed on its owner, enable reviews on
        every PR in one click — posted as the bot, no webhook setup.
      </p>

      <select
        className={selectClassName}
        value={owner && repo ? `${owner}/${repo}` : ''}
        onChange={(e) => {
          const [o, r] = e.target.value.split('/');
          setOwner(o ?? '');
          setRepo(r ?? '');
          // New repo → drop any just-installed confirmation (alreadyInstalled
          // re-derives from the triggers list for the newly-picked repo).
          setJustInstalled(false);
        }}
      >
        <option value="">{reposLoading ? 'Loading repos…' : 'Select a repository'}</option>
        {repos.map((r) => (
          <option key={r.id} value={r.fullName}>
            {r.fullName}
          </option>
        ))}
      </select>

      {!owner || !repo ? (
        <p className="text-xs text-neutral-500 dark:text-neutral-400">
          Pick a repository to continue.
        </p>
      ) : installed ? (
        <p className="text-sm text-green-600 dark:text-green-400">
          ✓ Installed for {owner}/{repo} via the GitHub App
        </p>
      ) : covered ? (
        <Button size="sm" onClick={handleEnable} disabled={enableApp.isPending}>
          {enableApp.isPending ? 'Enabling…' : 'Enable via GitHub App'}
        </Button>
      ) : appSlug ? (
        <div className="flex flex-col items-start gap-2">
          <p className="text-xs text-neutral-500 dark:text-neutral-400">
            The Valet GitHub App isn’t installed on <span className="font-medium">{owner}</span> yet.
          </p>
          <Button size="sm" asChild>
            <a
              href={`https://github.com/apps/${appSlug}/installations/new`}
              target="_blank"
              rel="noopener noreferrer"
            >
              Install the Valet App on {owner}
            </a>
          </Button>
        </div>
      ) : (
        <p className="text-xs text-neutral-500 dark:text-neutral-400">
          The Valet GitHub App isn’t installed on {owner}.
        </p>
      )}

      {/* Secondary: the webhook is now the fallback path, visually demoted. */}
      {webhook && (
        <details className="mt-1 rounded-lg bg-neutral-50 p-3 dark:bg-neutral-900/50">
          <summary className="cursor-pointer text-xs font-medium text-neutral-500 dark:text-neutral-400">
            Or wire it up manually with a webhook
          </summary>
          <div className="mt-2 flex flex-col gap-2">
            <p className="text-2xs text-neutral-500">
              Add this webhook to a GitHub repo (Settings → Webhooks, content type{' '}
              <code className="rounded bg-neutral-100 px-1 dark:bg-neutral-800">application/json</code>,
              event <em>Pull requests</em>). It then reviews every new or updated PR there — no per-PR
              setup.
            </p>
            <WebhookSecret trigger={webhook} />
          </div>
        </details>
      )}
    </div>
  );
}

/**
 * "Test on one PR" fields for the code-review template — pick a connected repo
 * and one of its open PRs instead of typing owner/repo/PR-number by hand. Falls
 * back to manual entry (a repo you haven't connected won't be in the list).
 * Populates the owner / repo / pullNumber trigger inputs.
 */
function GithubPrRunFields({
  values,
  onChange,
}: {
  values: Record<string, string>;
  onChange: React.Dispatch<React.SetStateAction<Record<string, string>>>;
}) {
  const [manual, setManual] = React.useState(false);
  const { data: reposData, isLoading: reposLoading } = useRepos();
  const repos = reposData?.repos ?? [];

  const owner = values.owner ?? '';
  const repo = values.repo ?? '';
  const { data: pullsData, isLoading: pullsLoading } = useRepoPulls(owner, repo);
  const pulls = pullsData ?? [];

  const set = (patch: Record<string, string>) => onChange((prev) => ({ ...prev, ...patch }));

  // No connected repos → nothing to pick from; use the free-text fields.
  const effectiveManual = manual || (!reposLoading && repos.length === 0);

  if (effectiveManual) {
    return (
      <div className="flex flex-col gap-2">
        <div className="grid grid-cols-2 gap-2">
          <Input placeholder="Repo owner (e.g. tkhq)" value={owner} onChange={(e) => set({ owner: e.target.value })} />
          <Input placeholder="Repo name (e.g. valet)" value={repo} onChange={(e) => set({ repo: e.target.value })} />
        </div>
        <Input
          type="number"
          placeholder="PR number"
          value={values.pullNumber ?? ''}
          onChange={(e) => set({ pullNumber: e.target.value })}
        />
        {repos.length > 0 && (
          <button type="button" className="self-start text-xs text-accent hover:underline" onClick={() => setManual(false)}>
            Pick from your repos instead
          </button>
        )}
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-2">
      <select
        className={selectClassName}
        value={owner && repo ? `${owner}/${repo}` : ''}
        onChange={(e) => {
          const [o, r] = e.target.value.split('/');
          // New repo → clear the previously-picked PR.
          set({ owner: o ?? '', repo: r ?? '', pullNumber: '' });
        }}
      >
        <option value="">{reposLoading ? 'Loading repos…' : 'Select a repository'}</option>
        {repos.map((r) => (
          <option key={r.id} value={r.fullName}>
            {r.fullName}
          </option>
        ))}
      </select>

      <select
        className={selectClassName}
        value={values.pullNumber ?? ''}
        disabled={!owner || !repo}
        onChange={(e) => set({ pullNumber: e.target.value })}
      >
        <option value="">
          {!owner || !repo
            ? 'Pick a repository first'
            : pullsLoading
              ? 'Loading open PRs…'
              : pulls.length === 0
                ? 'No open PRs'
                : 'Select an open PR'}
        </option>
        {pulls.map((p) => (
          <option key={p.number} value={String(p.number)}>
            #{p.number} — {p.title}
          </option>
        ))}
      </select>

      <button type="button" className="self-start text-xs text-accent hover:underline" onClick={() => setManual(true)}>
        Enter a repo manually
      </button>
    </div>
  );
}

/** One-time reveal of the webhook URL + token (the token is never shown again). */
function WebhookSecret({ trigger }: { trigger: InstalledTemplateTrigger }) {
  const copy = async (label: string, value: string) => {
    try {
      await navigator.clipboard.writeText(value);
      toastSuccess(`${label} copied`);
    } catch {
      // Clipboard API can fail on insecure origins / sandboxed iframes.
      toastSuccess('Copy unavailable', `Select and copy the ${label.toLowerCase()} manually.`);
    }
  };
  return (
    <div className="flex flex-col gap-2 rounded-lg bg-neutral-50 p-3 dark:bg-neutral-900/50">
      <p className="text-sm font-medium text-neutral-700 dark:text-neutral-300">Webhook</p>
      <p className="text-2xs text-neutral-500">
        Point a GitHub <code>pull_request</code> event here. The token is shown once.
      </p>
      <SecretRow label="URL" value={trigger.webhookUrl} onCopy={copy} />
      <SecretRow label="Token" value={trigger.webhookToken} onCopy={copy} mono />
    </div>
  );
}

function SecretRow({
  label,
  value,
  onCopy,
  mono,
}: {
  label: string;
  value: string;
  onCopy: (label: string, value: string) => void;
  mono?: boolean;
}) {
  return (
    <div className="flex items-center gap-2">
      <span className="w-10 shrink-0 font-mono text-2xs uppercase text-neutral-400">{label}</span>
      <code
        className={cn('flex-1 truncate rounded border border-neutral-200 bg-white px-2 py-1 text-xs dark:border-neutral-800 dark:bg-neutral-900', mono && 'font-mono')}
      >
        {value}
      </code>
      <Button size="sm" variant="ghost" onClick={() => onCopy(label, value)}>
        Copy
      </Button>
    </div>
  );
}

function ChevronRightIcon({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="m9 18 6-6-6-6" />
    </svg>
  );
}

function ClaudeMark({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
      <path d="M12 1.5l1.9 7.1a3 3 0 0 0 2.1 2.1l7.1 1.9-7.1 1.9a3 3 0 0 0-2.1 2.1L12 23.5l-1.9-7.1a3 3 0 0 0-2.1-2.1L.9 12.5l7.1-1.9a3 3 0 0 0 2.1-2.1L12 1.5z" />
    </svg>
  );
}
