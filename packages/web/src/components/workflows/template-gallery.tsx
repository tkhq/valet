/**
 * The workflow template gallery — the starting points `/workflows` offers.
 *
 * A template is a workflow a plugin ships, ready to install. Each card
 * answers the three questions a person asks before they commit: what does it
 * do, when does it run, and what must I connect first. The steps, the
 * limits, and the fields it needs are one click deeper, in the install
 * dialog, so the grid stays scannable.
 *
 * A template whose services are not connected does not offer an Install
 * button at all. A workflow tool node reads the credential of the run's
 * owner, so installing without the credential produces a workflow that fails
 * on its first run — a worse outcome than a card that says what to connect
 * and links to the page that connects it.
 *
 * No search box and no category chips. The catalog is small enough to read,
 * and filters over a screenful of cards are chrome. Add them when the
 * catalog outgrows one screen.
 */
import { useState } from "react";
import { Link } from "@tanstack/react-router";
import type { WorkflowTemplateRequirement, WorkflowTemplateSummary } from "@valet/api/wire";
import { Button, Spinner } from "~/components/primitives";
import { ServiceIcon } from "~/components/service-icon";
import { displayName } from "~/components/integrations/display-name";
import { useWorkflowTemplates } from "~/api/templates";
import { InstallTemplateDialog } from "./install-template-dialog";
import { describeCadence } from "./cadence";

/** "Slack", "Slack and Linear", "Slack, Linear and GitHub". */
export function joinNames(names: string[]): string {
  if (names.length === 0) return "";
  if (names.length === 1) return names[0]!;
  return `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
}

/** The services a template needs that the caller has not connected. */
export function missingServices(requires: WorkflowTemplateRequirement[]): string[] {
  return requires.filter((r) => !r.connected).map((r) => displayName(r.service));
}

export function TemplateGallery() {
  const { data, isLoading, error } = useWorkflowTemplates();
  const templates = data?.templates ?? [];

  if (isLoading) {
    return (
      <div className="flex items-center gap-2 text-sm text-muted">
        <Spinner size={14} /> Loading templates…
      </div>
    );
  }

  if (error) {
    return (
      <div className="text-sm text-danger-500">
        Could not load templates. Check that the server is running, then reload.
      </div>
    );
  }

  if (templates.length === 0) {
    return (
      <div className="text-sm text-muted">
        No templates available. Your installed plugins ship none, so start from a blank
        workflow instead.
      </div>
    );
  }

  return (
    <div className="grid gap-3 sm:grid-cols-2">
      {templates.map((template) => (
        <TemplateCard key={template.id} template={template} />
      ))}
    </div>
  );
}

function TemplateCard({ template }: { template: WorkflowTemplateSummary }) {
  const [open, setOpen] = useState(false);
  const missing = missingServices(template.requires);
  const ready = missing.length === 0;

  return (
    <div className="flex flex-col rounded-lg border border-line bg-paper p-4 transition-shadow hover:shadow-sm">
      {template.requires.length > 0 && (
        <div className="mb-3 flex items-center gap-1.5">
          {/* A service the caller has not connected is dimmed, so the chain
              shows at a glance which mark is the blocked one. Opacity, not
              the grey `quiet` tile: grey already means "built in, nothing to
              connect" on the integrations page. */}
          {template.requires.map((req) => (
            <ServiceIcon
              key={req.service}
              slug={req.service}
              label={displayName(req.service)}
              size="sm"
              className={req.connected ? undefined : "opacity-40"}
            />
          ))}
        </div>
      )}

      <div className="text-sm font-medium text-ink">{template.name}</div>
      <p className="mt-1 text-xs leading-relaxed text-muted">{template.description}</p>

      {!ready && (
        <p className="mt-3 text-xs leading-relaxed text-danger-600 dark:text-danger-500">
          Connect {joinNames(missing)} first, then install this.
        </p>
      )}

      <div className="mt-auto flex items-end justify-between gap-3 pt-4">
        <div className="min-w-0 font-mono text-xs leading-relaxed text-muted">
          <div>{describeCadence(template.schedule)}</div>
          <div className="truncate">{usesLine(template.requires)}</div>
        </div>
        {ready ? (
          <Button size="sm" className="shrink-0" onClick={() => setOpen(true)}>
            Use template
          </Button>
        ) : (
          <Button size="sm" variant="secondary" className="shrink-0" asChild>
            <Link to="/integrations">
              {missing.length === 1 ? `Connect ${missing[0]}` : "Connect integrations"}
            </Link>
          </Button>
        )}
      </div>

      {/* Mounted only while open, so every open starts from the declared
          defaults with no error left over from a previous attempt. */}
      {ready && open && (
        <InstallTemplateDialog template={template} open onOpenChange={setOpen} />
      )}
    </div>
  );
}

/** The mono "what it touches" line. Named services, because a row of letter
 * tiles does not tell a reader which services they are. */
function usesLine(requires: WorkflowTemplateRequirement[]): string {
  if (requires.length === 0) return "No integrations needed";
  return requires.map((r) => displayName(r.service)).join(" · ");
}
