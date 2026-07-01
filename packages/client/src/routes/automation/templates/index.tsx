import * as React from 'react';
import { createFileRoute, useNavigate } from '@tanstack/react-router';
import { Card, CardHeader, CardTitle, CardDescription, CardFooter } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
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
import { useWorkflowTemplates, useInstallTemplate, useRunWorkflowNow } from '@/api/templates';
import type { WorkflowTemplateSummary, InstalledTemplateTrigger } from '@valet/shared';

export const Route = createFileRoute('/automation/templates/')({
  component: TemplatesPage,
});

function TemplatesPage() {
  const { data, isLoading } = useWorkflowTemplates();
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
        <div className="relative max-w-md">
          <SearchIcon className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-neutral-400" />
          <Input
            className="pl-9"
            placeholder="Search templates"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
        </div>
        <div className="flex flex-wrap gap-2">
          {categories.map((c) => {
            const active = c === category;
            return (
              <button
                key={c}
                onClick={() => setCategory(c)}
                className={`rounded-full border px-3 py-1 text-sm transition-colors ${
                  active
                    ? 'border-accent bg-accent/10 text-accent'
                    : 'border-neutral-200 text-neutral-600 hover:border-neutral-300 hover:text-neutral-900 dark:border-neutral-700 dark:text-neutral-300 dark:hover:text-neutral-100'
                }`}
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
            <div
              key={i}
              className="h-44 animate-pulse rounded-xl border border-neutral-200 bg-white dark:border-neutral-800 dark:bg-surface-1"
            />
          ))}
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
      className={`flex ${box} items-center justify-center rounded-lg border border-neutral-200 bg-white dark:border-neutral-700 dark:bg-neutral-900`}
    >
      <AppGlyph service={service} className={glyph} />
    </span>
  );
}

/** Reuses the app's brand logos; the LLM review step gets a Claude spark mark. */
function AppGlyph({ service, className }: { service: string; className?: string }) {
  if (service === 'claude' || service === 'anthropic') {
    return <ClaudeMark className={`${className ?? ''} text-[#C15F3C]`} />;
  }
  const Icon = getServiceIcon(service);
  return <Icon className={`${className ?? ''} text-neutral-800 dark:text-neutral-100`} />;
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
  const run = useRunWorkflowNow();
  const [installedWorkflowId, setInstalledWorkflowId] = React.useState<string | null>(null);
  const [webhook, setWebhook] = React.useState<InstalledTemplateTrigger | null>(null);
  const [values, setValues] = React.useState<Record<string, string>>({});

  const handleInstall = () => {
    install.mutate(template.id, {
      onSuccess: (res) => {
        setInstalledWorkflowId(res.workflowId);
        if (res.trigger) setWebhook(res.trigger);
        toastSuccess('Template added', `"${res.workflowName}" is ready.`);
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
            <div className="flex flex-col gap-3 border-t border-neutral-100 pt-4 dark:border-neutral-800">
              {webhook && <WebhookSecret trigger={webhook} />}
              {template.inputs.length > 0 && (
                <>
                  <p className="text-sm font-medium text-neutral-700 dark:text-neutral-300">Run it now</p>
                  {template.inputs.map((input) => (
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
                  ))}
                </>
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
                  {run.isPending ? 'Starting…' : 'Run now'}
                </Button>
              )}
            </>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** One-time reveal of the webhook URL + token (the token is never shown again). */
function WebhookSecret({ trigger }: { trigger: InstalledTemplateTrigger }) {
  const copy = (label: string, value: string) => {
    void navigator.clipboard?.writeText(value);
    toastSuccess(`${label} copied`);
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
        className={`flex-1 truncate rounded border border-neutral-200 bg-white px-2 py-1 text-xs dark:border-neutral-800 dark:bg-neutral-900 ${mono ? 'font-mono' : ''}`}
      >
        {value}
      </code>
      <Button size="sm" variant="ghost" onClick={() => onCopy(label, value)}>
        Copy
      </Button>
    </div>
  );
}

function SearchIcon({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <circle cx="11" cy="11" r="8" />
      <path d="m21 21-4.3-4.3" />
    </svg>
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
