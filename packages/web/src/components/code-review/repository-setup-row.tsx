import { useRef, useState } from "react";
import { Link } from "@tanstack/react-router";
import type { EventSubscriptionWire } from "@valet/api/wire";
import { ApiError } from "~/api/api-error";
import { useCreateEventSubscription } from "~/api/events";
import { collisionsFromError } from "~/components/events/collision-notice";
import type { HandlerOption } from "~/components/plugins/handler-settings";
import { Switch, WorkRow, textLinkClass } from "~/components/primitives";
import { errorText } from "~/lib/error-text";
import { reviewLineBody } from "./review-lines";

/** An installed repository awaiting setup, or a configuration owned by another workspace. */
export function RepositorySetupRow({ repository, installed, line, scopeLabel = "another workspace", shared = false, handler, teamId, disabled = false, onAdded }: {
  repository: string;
  installed: boolean;
  line?: EventSubscriptionWire;
  scopeLabel?: string;
  shared?: boolean;
  handler: HandlerOption;
  teamId?: string;
  disabled?: boolean;
  onAdded: (id: string) => void;
}) {
  const create = useCreateEventSubscription();
  const locked = useRef(false);
  const [submitted, setSubmitted] = useState(false);
  const [created, setCreated] = useState(false);
  const [error, setError] = useState<Error | null>(null);
  const conflict = error instanceof ApiError && error.status === 409;
  const collisions = conflict ? collisionsFromError(error) : null;
  const detail = `${installed ? "GitHub App installed. " : ""}${line ? `Code review is ${line.enabled ? "on" : "off"} in ${scopeLabel}.` : "Code review is off."}${shared ? " Shared configuration. Changes apply to all repositories it covers." : ""}`;

  function turnOn(enabled: boolean) {
    if (!enabled || line || locked.current || disabled || create.isPending) return;
    locked.current = true;
    setSubmitted(true);
    setError(null);
    create.mutate(reviewLineBody(repository, handler, teamId), {
      onSuccess: (response) => { setCreated(true); onAdded(response.id); },
      onError: (failure) => { locked.current = false; setSubmitted(false); setError(failure); },
    });
  }

  return (
    <div>
      <WorkRow
        title={repository}
        detail={created ? <span role="status">Code review is on. Loading configuration…</span>
          : create.isPending || submitted ? <span role="status">Adding code review…</span> : detail}
        actions={(
          <>
            {line && <Link to="/presence/rules/$id" params={{ id: line.id }} className={`${textLinkClass} text-xs`}>Open configuration</Link>}
            <Switch checked={line?.enabled ?? submitted} disabled={line !== undefined || disabled || submitted || create.isPending || conflict} aria-label={`Review pull requests in ${repository}`} onCheckedChange={turnOn} />
          </>
        )}
      />
      {error && (
        <div role="alert" className="grid gap-1 px-4 pb-3 text-sm sm:px-5">
          <p className="text-danger-500">{conflict ? "Already configured. Open its configuration in Presence." : errorText(error)}</p>
          {conflict && (collisions?.blocking.length ? collisions.blocking.map(({ subscription }) => (
            <Link key={subscription.id} to="/presence/rules/$id" params={{ id: subscription.id }} className={textLinkClass}>{subscription.name}</Link>
          )) : <Link to="/presence" className={textLinkClass}>Open Presence</Link>)}
        </div>
      )}
    </div>
  );
}
