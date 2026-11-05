/**
 * One code review line on the Code review page: the repositories it covers,
 * an on/off switch, and its settings behind Settings. Save patches the
 * line's `config`; Remove deletes the line.
 */
import { useEffect, useState } from "react";
import { Link } from "@tanstack/react-router";
import type { EventSubscriptionWire } from "@valet/api/wire";
import { useDeleteEventSubscription, usePatchEventSubscription } from "~/api/events";
import { Button, ConfirmDialog, Switch, WorkRow, textLinkClass } from "~/components/primitives";
import { HandlerSettingsForm, sameSettings, type HandlerConfig, type HandlerOption } from "~/components/plugins/handler-settings";
import { errorText } from "~/lib/error-text";
import { lineRepos } from "./review-lines";

function storedConfig(line: EventSubscriptionWire): HandlerConfig {
  return line.target.kind === "plugin" ? line.target.config ?? {} : {};
}

export function RepositoryRow({ line, handler, initiallyOpen = false, openRequest }: {
  line: EventSubscriptionWire;
  handler: HandlerOption | undefined;
  /** True for a line the reader just added, so its settings show at once. */
  initiallyOpen?: boolean;
  /** A new request opens settings even when the row already exists. */
  openRequest?: number;
}) {
  const patch = usePatchEventSubscription();
  const remove = useDeleteEventSubscription();
  const [open, setOpen] = useState(initiallyOpen);
  const [config, setConfig] = useState(() => storedConfig(line));
  const [confirming, setConfirming] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const dirty = !sameSettings(config, storedConfig(line));
  useEffect(() => {
    if (openRequest !== undefined) setOpen(true);
  }, [openRequest]);
  // A refetched line resets the form, unless the reader has unsaved changes.
  useEffect(() => {
    if (!dirty) setConfig(storedConfig(line));
  }, [line.updatedAt]);

  const repos = lineRepos(line);
  const title = repos === null ? "Every repository" : repos.join(", ");

  function save() {
    setError(null);
    patch.mutate(
      { id: line.id, body: { config: Object.keys(config).length > 0 ? config : null } },
      { onError: (err) => setError(errorText(err)) },
    );
  }

  return (
    <div>
      <WorkRow
        title={title}
        detail={line.enabled ? "Reviews each push to an open pull request." : "Off. Pull requests are not reviewed."}
        actions={(
          <>
            <Button variant="ghost" size="sm" aria-expanded={open} onClick={() => setOpen(!open)}>
              Settings
            </Button>
            <Switch
              checked={line.enabled}
              disabled={patch.isPending}
              aria-label={`Review pull requests in ${title}`}
              onCheckedChange={(enabled) => patch.mutate({ id: line.id, body: { enabled } }, { onError: (err) => setError(errorText(err)) })}
            />
          </>
        )}
      />
      {open && (
        <div className="grid gap-3 border-t border-line px-4 py-3 sm:pl-5 sm:pr-3">
          {handler?.configSchema !== undefined
            ? <HandlerSettingsForm schema={handler.configSchema} value={config} onChange={setConfig} disabled={patch.isPending} />
            : <p className="text-xs text-muted">Valet cannot load the review settings. Reload the page to try again.</p>}
          {error !== null && <p role="alert" className="text-xs text-danger-500">{error}</p>}
          <div className="flex flex-wrap items-center gap-2">
            <Button size="sm" disabled={!dirty || patch.isPending} onClick={save}>{patch.isPending ? "Saving…" : "Save"}</Button>
            {dirty && <Button size="sm" variant="ghost" onClick={() => setConfig(storedConfig(line))}>Cancel</Button>}
            <Link to="/presence/rules/$id" params={{ id: line.id }} className={`${textLinkClass} text-xs`}>Open in Presence</Link>
            <Button size="sm" variant="ghost" className="ml-auto text-danger-500" onClick={() => setConfirming(true)}>Remove</Button>
          </div>
        </div>
      )}
      <ConfirmDialog
        open={confirming}
        onOpenChange={setConfirming}
        title="Stop code review here?"
        description={`Valet stops reviewing pull requests in ${title}. Reviews it already posted stay on GitHub.`}
        confirmLabel="Remove"
        pendingLabel="Removing…"
        pending={remove.isPending}
        error={remove.error ? errorText(remove.error) : undefined}
        onConfirm={() => remove.mutate(line.id, { onSuccess: () => setConfirming(false) })}
      />
    </div>
  );
}
