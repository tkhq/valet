import * as React from 'react';
import { createFileRoute, useNavigate } from '@tanstack/react-router';
import { Card, CardHeader, CardTitle, CardDescription, CardContent, CardFooter } from '@/components/ui/card';
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
import { useWorkflowTemplates, useInstallTemplate, useRunWorkflowNow } from '@/api/templates';
import type {
  WorkflowTemplateSummary,
  InstalledTemplateTrigger,
} from '@valet/shared';

export const Route = createFileRoute('/automation/templates/')({
  component: TemplatesPage,
});

function TemplatesPage() {
  const { data, isLoading } = useWorkflowTemplates();

  if (isLoading) {
    return (
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {Array.from({ length: 3 }).map((_, i) => (
          <div
            key={i}
            className="h-48 animate-pulse rounded-lg border border-neutral-200 bg-white dark:border-neutral-800 dark:bg-surface-1"
          />
        ))}
      </div>
    );
  }

  const templates = data?.templates ?? [];

  if (templates.length === 0) {
    return (
      <div className="flex h-48 flex-col items-center justify-center gap-1 text-center">
        <p className="text-sm font-medium text-neutral-700 dark:text-neutral-300">No templates yet</p>
        <p className="text-sm text-neutral-500">Pre-built automations will show up here.</p>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-4">
      <p className="text-sm text-neutral-500 dark:text-neutral-400">
        Start from a pre-built automation. Installing creates a published workflow you can run or wire up to a webhook.
      </p>
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {templates.map((t) => (
          <TemplateCard key={t.id} template={t} />
        ))}
      </div>
    </div>
  );
}

function TemplateCard({ template }: { template: WorkflowTemplateSummary }) {
  const navigate = useNavigate();
  const install = useInstallTemplate();
  const [installedWorkflowId, setInstalledWorkflowId] = React.useState<string | null>(null);
  const [webhook, setWebhook] = React.useState<InstalledTemplateTrigger | null>(null);
  const [runOpen, setRunOpen] = React.useState(false);

  const handleInstall = () => {
    install.mutate(template.id, {
      onSuccess: (res) => {
        setInstalledWorkflowId(res.workflowId);
        if (res.trigger) setWebhook(res.trigger);
        toastSuccess('Template installed', `"${res.workflowName}" is ready to run.`);
      },
      onError: (err) => {
        toastError('Install failed', err instanceof Error ? err.message : 'Could not install template.');
      },
    });
  };

  return (
    <>
      <Card className="flex flex-col">
        <CardHeader>
          <div className="flex items-start justify-between gap-2">
            <div className="flex items-center gap-2">
              {template.icon && <span className="text-lg">{template.icon}</span>}
              <CardTitle>{template.name}</CardTitle>
            </div>
            <Badge variant="secondary">{template.category}</Badge>
          </div>
          <CardDescription>{template.description}</CardDescription>
        </CardHeader>
        <CardContent className="flex-1">
          {template.hasWebhook && (
            <span className="font-mono text-2xs uppercase tracking-wide text-neutral-400">
              webhook-triggerable
            </span>
          )}
        </CardContent>
        <CardFooter className="flex flex-wrap gap-2">
          {installedWorkflowId ? (
            <>
              {template.inputs.length > 0 && (
                <Button size="sm" onClick={() => setRunOpen(true)}>
                  Run now
                </Button>
              )}
              <Button
                size="sm"
                variant="outline"
                onClick={() =>
                  navigate({
                    to: '/automation/workflows/$workflowId',
                    params: { workflowId: installedWorkflowId },
                  })
                }
              >
                Open workflow
              </Button>
            </>
          ) : (
            <Button size="sm" onClick={handleInstall} disabled={install.isPending}>
              {install.isPending ? 'Installing…' : 'Use this template'}
            </Button>
          )}
        </CardFooter>
      </Card>

      {webhook && <WebhookSecretDialog trigger={webhook} onClose={() => setWebhook(null)} />}

      {installedWorkflowId && (
        <RunNowDialog
          open={runOpen}
          onOpenChange={setRunOpen}
          template={template}
          workflowId={installedWorkflowId}
          onRan={() =>
            navigate({
              to: '/automation/workflows/$workflowId',
              params: { workflowId: installedWorkflowId },
            })
          }
        />
      )}
    </>
  );
}

/** One-time reveal of the webhook URL + token (the token is never shown again). */
function WebhookSecretDialog({
  trigger,
  onClose,
}: {
  trigger: InstalledTemplateTrigger;
  onClose: () => void;
}) {
  const copy = (label: string, value: string) => {
    void navigator.clipboard?.writeText(value);
    toastSuccess(`${label} copied`);
  };
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Webhook created</DialogTitle>
          <DialogDescription>
            Send a GitHub <code>pull_request</code> event here. The token is shown once — copy it now.
          </DialogDescription>
        </DialogHeader>
        <div className="flex flex-col gap-3">
          <SecretRow label="Webhook URL" value={trigger.webhookUrl} onCopy={copy} />
          <SecretRow label="X-Valet-Trigger-Token" value={trigger.webhookToken} onCopy={copy} mono />
        </div>
        <DialogFooter>
          <Button size="sm" onClick={onClose}>
            Done
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
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
    <div className="flex flex-col gap-1">
      <span className="font-mono text-2xs uppercase tracking-wide text-neutral-400">{label}</span>
      <div className="flex items-center gap-2">
        <code
          className={`flex-1 truncate rounded border border-neutral-200 bg-neutral-50 px-2 py-1 text-xs dark:border-neutral-800 dark:bg-neutral-900 ${mono ? 'font-mono' : ''}`}
        >
          {value}
        </code>
        <Button size="sm" variant="ghost" onClick={() => onCopy(label, value)}>
          Copy
        </Button>
      </div>
    </div>
  );
}

/** Collects the template inputs and runs the installed workflow now. */
function RunNowDialog({
  open,
  onOpenChange,
  template,
  workflowId,
  onRan,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  template: WorkflowTemplateSummary;
  workflowId: string;
  onRan: () => void;
}) {
  const run = useRunWorkflowNow();
  const [values, setValues] = React.useState<Record<string, string>>({});

  const submit = () => {
    // Coerce number inputs; leave the rest as strings.
    const variables: Record<string, unknown> = {};
    for (const input of template.inputs) {
      const raw = values[input.name] ?? '';
      variables[input.name] = input.type === 'number' ? Number(raw) : raw;
    }
    run.mutate(
      { workflowId, variables },
      {
        onSuccess: () => {
          toastSuccess('Run started', 'The workflow is running — check its run history.');
          onOpenChange(false);
          onRan();
        },
        onError: (err) => {
          toastError('Run failed', err instanceof Error ? err.message : 'Could not start the run.');
        },
      },
    );
  };

  const missingRequired = template.inputs.some(
    (i) => i.required && !(values[i.name] ?? '').trim(),
  );

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Run {template.name}</DialogTitle>
          <DialogDescription>Enter the inputs to run this automation now.</DialogDescription>
        </DialogHeader>
        <div className="flex flex-col gap-3">
          {template.inputs.map((input) => (
            <div key={input.name} className="flex flex-col gap-1">
              <label className="text-sm font-medium text-neutral-700 dark:text-neutral-300">
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
        </div>
        <DialogFooter>
          <Button variant="ghost" size="sm" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button size="sm" onClick={submit} disabled={run.isPending || missingRequired}>
            {run.isPending ? 'Starting…' : 'Run now'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
