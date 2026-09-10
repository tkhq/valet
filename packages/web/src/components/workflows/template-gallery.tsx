/**
 * The workflow template gallery — the starting points `/workflows` offers.
 *
 * Each card answers the three questions a person asks before they commit:
 * what does it do, when does it run, and what must I connect first. The
 * steps, the limits, and the fields it needs are one click deeper, in the
 * install dialog, so the grid stays scannable.
 *
 * A template whose services are not connected offers no Install button. A
 * workflow tool node reads the credential of the run's owner, so installing
 * without the credential produces a workflow that fails on its first run — a
 * worse outcome than a card that says what to connect and links to the page
 * that connects it. Whose credential that is depends on the active
 * workspace; see `template-requirements.ts`.
 *
 * No search box and no category chips. The catalog is small enough to read.
 * Add them when it outgrows one screen.
 */
import { useState } from "react";
import { Link } from "@tanstack/react-router";
import type { WorkflowTemplateSummary } from "@valet/api/wire";
import { Button, Spinner } from "~/components/primitives";
import { ServiceIcon } from "~/components/service-icon";
import { displayName } from "~/components/integrations/display-name";
import { useWorkflowTemplates } from "~/api/templates";
import { useWorkspaceScope } from "~/lib/workspace-scope";
import { InstallTemplateDialog } from "./install-template-dialog";
import { describeCadence } from "./cadence";
import {
  connectLabel,
  isInstallable,
  missingServices,
  unconfiguredNote,
  unconfiguredServices,
} from "./template-requirements";

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
  const unconfigured = unconfiguredServices(template.requires);
  const ready = isInstallable(template.requires, template.blockers);
  const scope = useWorkspaceScope();

  return (
    <div className="flex flex-col rounded-lg border border-line bg-paper p-4 transition-shadow hover:shadow-sm">
      {template.requires.length > 0 && (
        <div className="mb-3 flex items-center gap-1.5">
          {/* Opacity for an unconnected service, not the grey `quiet` tile:
              grey already means "built in, nothing to connect" on the
              integrations page. */}
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

      <div className="text-sm font-medium text-pretty text-ink">{template.name}</div>
      {/* Two lines, not the whole paragraph: a gallery is scanned, and the
          install dialog carries the full description. */}
      <p className="mt-1 line-clamp-2 text-xs leading-relaxed text-muted">{template.description}</p>

      <div className="mt-auto flex items-end justify-between gap-3 pt-4">
        {/* Cadence only. The service chain above already names what this
            needs, and the button already says what to connect. */}
        <div className="min-w-0 truncate text-xs text-muted">
          {describeCadence(template.schedule)}
        </div>
        <div className="flex shrink-0 items-center gap-2">
          {/* Every card opens its own details, whatever its connection state.
              The steps and the limits live ONLY in this dialog, and a card
              that cannot be installed is the card whose limits matter most:
              its reader is deciding whether to connect a service, or to ask
              an admin to. */}
          {!ready && (
            <Button size="sm" variant="ghost" onClick={() => setOpen(true)}>
              What it does
            </Button>
          )}
          {ready ? (
            <Button size="sm" onClick={() => setOpen(true)}>
              Use template
            </Button>
          ) : missing.length > 0 ? (
            <Button size="sm" variant="secondary" asChild>
              <Link to="/integrations">{connectLabel(missing, scope.teamId)}</Link>
            </Button>
          ) : null}
        </div>
      </div>

      {/* Below the controls, not on them: an admin's job is not a button the
          reader can press. */}
      {unconfigured.length > 0 && (
        <p className="pt-2 text-xs leading-relaxed text-muted">{unconfiguredNote(unconfigured)}</p>
      )}

      {template.blockers?.map((reason) => (
        <p key={reason} className="pt-2 text-xs leading-relaxed text-muted">{reason}</p>
      ))}

      {/* Mounted only while open, so every open starts from the declared
          defaults with no error left over from a previous attempt. */}
      {open && <InstallTemplateDialog template={template} open onOpenChange={setOpen} />}
    </div>
  );
}
